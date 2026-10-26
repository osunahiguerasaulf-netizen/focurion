require('dotenv').config();

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const DB_NAME = String(process.env.DB_NAME || 'focurion').replace(/[^a-zA-Z0-9_]/g, '_');
const CONFIGURED_DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const IS_LOCAL_DB = ['127.0.0.1', 'localhost', '::1'].includes(String(DB_HOST).toLowerCase());
const DB_PORT_CANDIDATES = IS_LOCAL_DB
  ? [...new Set([CONFIGURED_DB_PORT, 3306, 3307])].filter(port => Number.isInteger(port) && port > 0 && port <= 65535)
  : [CONFIGURED_DB_PORT];
const DB_SSL_ENABLED = String(process.env.DB_SSL || '').toLowerCase() === 'true';
const DB_CONFIG = {
  host: DB_HOST,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  ...(DB_SSL_ENABLED ? { ssl: { rejectUnauthorized: String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false' } } : {})
};

const app = express();
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);
let pool;
let activeDbPort = CONFIGURED_DB_PORT;
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 6;

function now() {
  return new Date().toISOString();
}

function dateOnly(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function isDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function text(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function loginAttemptKey(req, email) {
  return `${req.ip || req.socket?.remoteAddress || 'local'}:${email}`;
}

function getLoginAttempt(key) {
  const attempt = loginAttempts.get(key);
  if (!attempt || Date.now() - attempt.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return null;
  }
  return attempt;
}

function recordLoginFailure(key) {
  const attempt = getLoginAttempt(key) || { count:0, startedAt:Date.now() };
  attempt.count += 1;
  loginAttempts.set(key, attempt);
  return attempt;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function all(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function one(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

async function run(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

function publicUser(row) {
  if (!row) return null;
  const { password_hash, ...safe } = row;
  safe.is_active = Number(safe.is_active || 0);
  safe.notifications = Number(safe.notifications || 0);
  return safe;
}

async function addXp(userId, amount) {
  await run('UPDATE users SET xp = GREATEST(0, xp + ?) WHERE id = ?', [amount, userId]);
}

async function logActivity(userId, action, entityType = null, entityId = null, detail = '') {
  await run(
    'INSERT INTO admin_activity (user_id, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
    [userId || null, action, entityType, entityId || null, text(detail, 500), now()]
  );
}

async function deliverResetCode(user, code) {
  const smtpReady = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;
  if (!smtpReady) {
    console.log(`[Focurion] Código de recuperación para ${user.email}: ${code}`);
    return { delivered: false, developmentCode: code };
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || `Focurion <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: 'Código para restablecer tu contraseña de Focurion',
      text: `Tu código de recuperación es ${code}. Vence en 15 minutos. Si no solicitaste este cambio, ignora este mensaje.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#172036"><h2>Recupera tu acceso a Focurion</h2><p>Usa este código para crear una nueva contraseña:</p><div style="font-size:32px;font-weight:800;letter-spacing:8px;padding:18px;background:#eef3ff;border-radius:12px;text-align:center">${code}</div><p>El código vence en 15 minutos.</p></div>`
    });
    return { delivered: true };
  } catch (error) {
    console.warn(`[Focurion] SMTP no disponible (${error.message}). Código local para ${user.email}: ${code}`);
    return { delivered: false, developmentCode: code };
  }
}

async function createDatabase() {
  const failures = [];
  for (const port of DB_PORT_CANDIDATES) {
    let bootstrap;
    try {
      // En XAMPP/local se conserva el comportamiento original: crear la base si no existe.
      // En hosting remoto la base normalmente ya es creada por el proveedor y el usuario
      // no tiene permisos CREATE DATABASE, así que conectamos directamente a DB_NAME.
      if (IS_LOCAL_DB && String(process.env.DB_SKIP_CREATE || 'false').toLowerCase() !== 'true') {
        bootstrap = await mysql.createConnection({ ...DB_CONFIG, port, connectTimeout: 5000 });
        await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await bootstrap.end();
      }

      activeDbPort = port;
      pool = mysql.createPool({
        ...DB_CONFIG,
        port,
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
        queueLimit: 0,
        charset: 'utf8mb4',
        dateStrings: true,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        connectTimeout: 10000
      });
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      failures.push(`${DB_CONFIG.host}:${port}: ${error.message}`);
      if (bootstrap) await bootstrap.end().catch(() => {});
      if (!IS_LOCAL_DB) break;
    }
  }
  const target = IS_LOCAL_DB ? `puertos ${DB_PORT_CANDIDATES.join(', ')}` : `${DB_CONFIG.host}:${CONFIGURED_DB_PORT}/${DB_NAME}`;
  const error = new Error(`No se pudo conectar con MySQL en ${target}. ${failures.join(' | ')}`);
  error.code = error.code || 'ECONNREFUSED';
  throw error;
}

async function createSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      email VARCHAR(120) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      university VARCHAR(80) DEFAULT 'UPSIN',
      career VARCHAR(120) DEFAULT 'Ingeniería en Tecnologías de la Información',
      role ENUM('student','moderator','admin') NOT NULL DEFAULT 'student',
      status ENUM('active','pending','suspended') NOT NULL DEFAULT 'active',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      xp INT UNSIGNED NOT NULL DEFAULT 0,
      streak INT UNSIGNED NOT NULL DEFAULT 1,
      avatar_color VARCHAR(20) DEFAULT '#6d5dfc',
      theme ENUM('dark','light') DEFAULT 'dark',
      language VARCHAR(8) DEFAULT 'es',
      timezone VARCHAR(80) DEFAULT 'America/Mazatlan',
      pomodoro_minutes SMALLINT UNSIGNED DEFAULT 25,
      short_break_minutes SMALLINT UNSIGNED DEFAULT 5,
      long_break_minutes SMALLINT UNSIGNED DEFAULT 15,
      weekly_goal_hours SMALLINT UNSIGNED DEFAULT 12,
      notifications TINYINT(1) DEFAULT 1,
      created_at VARCHAR(30) NOT NULL,
      last_active VARCHAR(30) NULL,
      INDEX idx_users_role(role),
      INDEX idx_users_status(status)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS communities (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      owner_id INT UNSIGNED NOT NULL,
      name VARCHAR(120) NOT NULL,
      description TEXT,
      category VARCHAR(80) DEFAULT 'Tecnología',
      university VARCHAR(80) DEFAULT 'General',
      is_private TINYINT(1) DEFAULT 0,
      status ENUM('active','pending','suspended') DEFAULT 'active',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_communities_owner FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS community_members (
      community_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      joined_at VARCHAR(30) NOT NULL,
      PRIMARY KEY(community_id,user_id),
      CONSTRAINT fk_cm_community FOREIGN KEY(community_id) REFERENCES communities(id) ON DELETE CASCADE,
      CONSTRAINT fk_cm_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS rooms (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      owner_id INT UNSIGNED NOT NULL,
      community_id INT UNSIGNED NULL,
      name VARCHAR(120) NOT NULL,
      topic VARCHAR(80) DEFAULT 'General',
      description TEXT,
      category VARCHAR(80) DEFAULT 'General',
      capacity INT UNSIGNED DEFAULT 30,
      is_private TINYINT(1) DEFAULT 0,
      access_code VARCHAR(80) DEFAULT '',
      status ENUM('active','pending','closed') DEFAULT 'active',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_rooms_owner FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_rooms_community FOREIGN KEY(community_id) REFERENCES communities(id) ON DELETE SET NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS room_members (
      room_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      joined_at VARCHAR(30) NOT NULL,
      PRIMARY KEY(room_id,user_id),
      CONSTRAINT fk_rm_room FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      CONSTRAINT fk_rm_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS room_messages (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      room_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      content TEXT NOT NULL,
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_messages_room FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      CONSTRAINT fk_messages_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS room_objectives (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      room_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      content VARCHAR(240) NOT NULL,
      completed TINYINT(1) NOT NULL DEFAULT 0,
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_objectives_room FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      CONSTRAINT fk_objectives_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS room_resources (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      room_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      title VARCHAR(160) NOT NULL,
      url VARCHAR(1000) NOT NULL,
      resource_type ENUM('link','document','repository','video') DEFAULT 'link',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_room_resources_room FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      CONSTRAINT fk_room_resources_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      title VARCHAR(160) NOT NULL,
      description TEXT,
      due_date VARCHAR(10) NULL,
      priority ENUM('low','medium','high') DEFAULT 'medium',
      status ENUM('pending','completed') DEFAULT 'pending',
      created_at VARCHAR(30) NOT NULL,
      completed_at VARCHAR(30) NULL,
      CONSTRAINT fk_tasks_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS goals (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      title VARCHAR(160) NOT NULL,
      target DECIMAL(10,2) NOT NULL DEFAULT 1,
      current DECIMAL(10,2) NOT NULL DEFAULT 0,
      unit VARCHAR(40) DEFAULT 'sesiones',
      due_date VARCHAR(10) NULL,
      status ENUM('active','completed') DEFAULT 'active',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_goals_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS notes (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      title VARCHAR(160) NOT NULL,
      content MEDIUMTEXT,
      created_at VARCHAR(30) NOT NULL,
      updated_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_notes_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS pomodoro_sessions (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      task_id INT UNSIGNED NULL,
      duration_minutes SMALLINT UNSIGNED NOT NULL,
      completed TINYINT(1) NOT NULL DEFAULT 1,
      started_at VARCHAR(30) NOT NULL,
      ended_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_pomo_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_pomo_task FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS posts (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      community_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      content TEXT NOT NULL,
      status ENUM('visible','hidden') DEFAULT 'visible',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_posts_community FOREIGN KEY(community_id) REFERENCES communities(id) ON DELETE CASCADE,
      CONSTRAINT fk_posts_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS comments (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      post_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      content TEXT NOT NULL,
      status ENUM('visible','hidden') DEFAULT 'visible',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_comments_post FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
      CONSTRAINT fk_comments_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS post_likes (
      post_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      created_at VARCHAR(30) NOT NULL,
      PRIMARY KEY(post_id,user_id),
      CONSTRAINT fk_post_likes_post FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
      CONSTRAINT fk_post_likes_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS post_saves (
      post_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      created_at VARCHAR(30) NOT NULL,
      PRIMARY KEY(post_id,user_id),
      CONSTRAINT fk_post_saves_post FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
      CONSTRAINT fk_post_saves_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS community_resources (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      community_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      title VARCHAR(160) NOT NULL,
      description VARCHAR(500) DEFAULT '',
      url VARCHAR(1000) NOT NULL,
      resource_type ENUM('link','pdf','repository','video','notes') DEFAULT 'link',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_resources_community FOREIGN KEY(community_id) REFERENCES communities(id) ON DELETE CASCADE,
      CONSTRAINT fk_resources_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS community_projects (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      community_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      title VARCHAR(160) NOT NULL,
      description VARCHAR(1000) DEFAULT '',
      stack VARCHAR(255) DEFAULT '',
      project_url VARCHAR(1000) DEFAULT '',
      status ENUM('development','review','completed') DEFAULT 'development',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_projects_community FOREIGN KEY(community_id) REFERENCES communities(id) ON DELETE CASCADE,
      CONSTRAINT fk_projects_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS community_challenges (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      community_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      title VARCHAR(160) NOT NULL,
      description VARCHAR(1000) DEFAULT '',
      difficulty ENUM('Básica','Intermedia','Avanzada') DEFAULT 'Básica',
      estimated_time VARCHAR(80) DEFAULT '1 día',
      xp INT UNSIGNED DEFAULT 50,
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_challenges_community FOREIGN KEY(community_id) REFERENCES communities(id) ON DELETE CASCADE,
      CONSTRAINT fk_challenges_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS password_reset_codes (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      code_hash VARCHAR(255) NOT NULL,
      expires_at VARCHAR(30) NOT NULL,
      used_at VARCHAR(30) NULL,
      created_at VARCHAR(30) NOT NULL,
      INDEX idx_reset_user(user_id),
      CONSTRAINT fk_reset_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS events (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      community_id INT UNSIGNED NULL,
      title VARCHAR(160) NOT NULL,
      description TEXT,
      type VARCHAR(50) DEFAULT 'Personal',
      start_date VARCHAR(10) NOT NULL,
      end_date VARCHAR(10) NULL,
      start_time VARCHAR(8) DEFAULT '18:00',
      color VARCHAR(20) DEFAULT '#5b8cff',
      is_official TINYINT(1) DEFAULT 0,
      status ENUM('pending','scheduled','active','rejected','completed') DEFAULT 'scheduled',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_events_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_events_community FOREIGN KEY(community_id) REFERENCES communities(id) ON DELETE SET NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS ai_history (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      mode VARCHAR(30) DEFAULT 'explain',
      prompt TEXT NOT NULL,
      response MEDIUMTEXT NOT NULL,
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_ai_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS moderation_reports (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      reporter_id INT UNSIGNED NULL,
      entity_type ENUM('user','community','room','post','comment') NOT NULL,
      entity_id INT UNSIGNED NOT NULL,
      entity_name VARCHAR(160) NOT NULL,
      reason VARCHAR(255) NOT NULL,
      detail TEXT,
      status ENUM('pending','resolved','dismissed') DEFAULT 'pending',
      created_at VARCHAR(30) NOT NULL,
      resolved_at VARCHAR(30) NULL,
      resolved_by INT UNSIGNED NULL,
      CONSTRAINT fk_reports_reporter FOREIGN KEY(reporter_id) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_reports_resolver FOREIGN KEY(resolved_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS admin_activity (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NULL,
      action VARCHAR(120) NOT NULL,
      entity_type VARCHAR(50) NULL,
      entity_id INT UNSIGNED NULL,
      detail VARCHAR(500) DEFAULT '',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_activity_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS system_settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB`
  ];
  for (const statement of statements) await pool.query(statement);
}

async function seedDb() {
  const count = await one('SELECT COUNT(*) AS total FROM users');
  if (Number(count.total) > 0) return;
  const stamp = now();
  const insertUser = async (name, email, password, university, career, role, xp, streak, status = 'active') => {
    const result = await run(
      `INSERT INTO users (name,email,password_hash,university,career,role,status,is_active,xp,streak,created_at,last_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, email, bcrypt.hashSync(password, 10), university, career, role, status, status === 'active' ? 1 : 0, xp, streak, stamp, stamp]
    );
    return result.insertId;
  };

  const adminId = await insertUser('Administrador', 'admin@focurion.local', 'Admin123!', 'Focurion', 'Administración', 'admin', 1200, 15);
  const demoId = await insertUser('Saúl Osuna', 'alumno@focurion.local', 'Demo123!', 'UPSIN', 'Ingeniería en Tecnologías de la Información', 'student', 790, 7);
  const anaId = await insertUser('Ana Torres', 'ana@demo.local', 'Demo123!', 'UNAM', 'Desarrollo de software', 'student', 960, 12);
  const luisId = await insertUser('Luis Medina', 'luis@demo.local', 'Demo123!', 'UPSIN', 'Tecnologías de la Información', 'moderator', 850, 9);
  const michelleId = await insertUser('Michelle Cárdenas', 'michelle@demo.local', 'Demo123!', 'UAS', 'Tecnologías de la Información', 'student', 740, 6, 'pending');
  const jassielId = await insertUser('Jassiel Jiménez', 'jassiel@demo.local', 'Demo123!', 'IPN', 'Informática', 'student', 700, 5, 'suspended');

  const tasks = [
    ['Terminar práctica de React','Componentes, props y hooks',dateOnly(1),'high','pending'],
    ['Repasar redes TCP/IP','Capas, direccionamiento y protocolos',dateOnly(3),'medium','pending'],
    ['Subir proyecto a GitHub','Publicar repositorio y README',dateOnly(-1),'low','completed'],
    ['Estudiar algoritmos','Complejidad y estructuras',dateOnly(6),'medium','pending']
  ];
  for (const task of tasks) await run('INSERT INTO tasks (user_id,title,description,due_date,priority,status,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?)', [demoId,...task,stamp,task[4] === 'completed' ? stamp : null]);

  const goals = [
    ['Estudiar 12 horas',12,8,'horas',dateOnly(7),'active'],
    ['Completar 6 pomodoros',6,4,'pomodoros',dateOnly(7),'active'],
    ['Resolver 3 retos',3,1,'retos',dateOnly(7),'active'],
    ['Participar en una sala colaborativa',1,1,'sesión',dateOnly(7),'completed']
  ];
  for (const goal of goals) await run('INSERT INTO goals (user_id,title,target,current,unit,due_date,status,created_at) VALUES (?,?,?,?,?,?,?,?)', [demoId,...goal,stamp]);
  await run('INSERT INTO notes (user_id,title,content,created_at,updated_at) VALUES (?,?,?,?,?)', [demoId,'Apuntes rápidos','Revisar el pull request de Ana. Investigar sobre Server Actions en React.',stamp,stamp]);

  const communities = [
    [adminId,'UPSIN Tech','Comunidad universitaria de tecnología de UPSIN.','Universidad','UPSIN','active'],
    [anaId,'UNAM Developers','Desarrollo web, recursos y proyectos colaborativos.','Programación','UNAM','active'],
    [luisId,'IPN Code Community','Retos, algoritmos y sesiones técnicas.','Programación','IPN','active'],
    [michelleId,'UAS Tecnología','Comunidad en proceso de validación.','Tecnología','UAS','pending']
  ];
  const communityIds = [];
  for (const item of communities) {
    const result = await run('INSERT INTO communities (owner_id,name,description,category,university,is_private,status,created_at) VALUES (?,?,?,?,?,?,?,?)', [...item.slice(0,5),0,item[5],stamp]);
    communityIds.push(result.insertId);
  }
  for (const communityId of communityIds.slice(0,3)) {
    for (const userId of [adminId,demoId,anaId,luisId]) await run('INSERT IGNORE INTO community_members (community_id,user_id,joined_at) VALUES (?,?,?)', [communityId,userId,stamp]);
  }

  const roomRows = [
    [adminId,communityIds[0],'Programación Web','Programación','Estudia HTML, CSS, JavaScript y frameworks.','Frontend',120,0,'active'],
    [anaId,communityIds[1],'Ciberseguridad','Ciberseguridad','Buenas prácticas, laboratorios y retos.','Blue Team',76,0,'active'],
    [adminId,communityIds[0],'React','Programación','Hooks, componentes y proyectos.','React',93,0,'active'],
    [luisId,communityIds[2],'SQL','Bases de datos','Consultas, modelado y optimización.','Bases de datos',51,0,'active'],
    [adminId,communityIds[0],'Redes TCP/IP','Redes','Protocolos, direccionamiento y prácticas.','Redes',42,0,'active'],
    [michelleId,communityIds[3],'Sala privada React','React','Sesión privada para proyecto.','React',12,1,'pending']
  ];
  const roomIds = [];
  for (const room of roomRows) {
    const result = await run('INSERT INTO rooms (owner_id,community_id,name,topic,description,category,capacity,is_private,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [...room,stamp]);
    roomIds.push(result.insertId);
  }
  for (const roomId of roomIds.slice(0,5)) {
    for (const userId of [demoId,adminId,anaId]) await run('INSERT IGNORE INTO room_members (room_id,user_id,joined_at) VALUES (?,?,?)', [roomId,userId,stamp]);
  }
  await run('INSERT INTO room_messages (room_id,user_id,content,created_at) VALUES (?,?,?,?)', [roomIds[0],adminId,'Bienvenido a la sala. Comparte dudas y avances de tu proyecto.',stamp]);
  await run('INSERT INTO room_objectives (room_id,user_id,content,created_at) VALUES (?,?,?,?)', [roomIds[0],demoId,'Terminar componentes de React',stamp]);
  await run('INSERT INTO room_objectives (room_id,user_id,content,created_at) VALUES (?,?,?,?)', [roomIds[0],anaId,'Practicar hooks',stamp]);
  await run('INSERT INTO room_objectives (room_id,user_id,content,created_at) VALUES (?,?,?,?)', [roomIds[0],luisId,'Subir proyecto a GitHub',stamp]);
  await run('INSERT INTO room_resources (room_id,user_id,title,url,resource_type,created_at) VALUES (?,?,?,?,?,?)', [roomIds[0],adminId,'Documentación React','https://react.dev','document',stamp]);
  await run('INSERT INTO room_resources (room_id,user_id,title,url,resource_type,created_at) VALUES (?,?,?,?,?,?)', [roomIds[0],anaId,'Guía CSS Grid','https://developer.mozilla.org/es/docs/Web/CSS/CSS_grid_layout','link',stamp]);

  const postResult = await run('INSERT INTO posts (community_id,user_id,content,created_at) VALUES (?,?,?,?)', [communityIds[0],adminId,'¡Bienvenidos! Compartan recursos, dudas y logros académicos.',stamp]);
  await run('INSERT INTO comments (post_id,user_id,content,created_at) VALUES (?,?,?,?)', [postResult.insertId,demoId,'Listo para aprender y colaborar.',stamp]);
  await run('INSERT INTO community_resources (community_id,user_id,title,description,url,resource_type,created_at) VALUES (?,?,?,?,?,?,?)', [communityIds[0],anaId,'Guía de React Hooks','Documentación práctica para comenzar con hooks.','https://react.dev/reference/react','link',stamp]);
  await run('INSERT INTO community_resources (community_id,user_id,title,description,url,resource_type,created_at) VALUES (?,?,?,?,?,?,?)', [communityIds[0],luisId,'Cheatsheet SQL','Apuntes y consultas SQL frecuentes.','https://dev.mysql.com/doc/','pdf',stamp]);
  await run('INSERT INTO community_projects (community_id,user_id,title,description,stack,project_url,status,created_at) VALUES (?,?,?,?,?,?,?,?)', [communityIds[0],demoId,'Focurion Dashboard','Dashboard académico responsive.','HTML, CSS, JavaScript','', 'development',stamp]);
  await run('INSERT INTO community_projects (community_id,user_id,title,description,stack,project_url,status,created_at) VALUES (?,?,?,?,?,?,?,?)', [communityIds[0],luisId,'CRUD Académico','Gestión de registros académicos.','Node.js, MySQL','', 'completed',stamp]);
  await run('INSERT INTO community_challenges (community_id,user_id,title,description,difficulty,estimated_time,xp,created_at) VALUES (?,?,?,?,?,?,?,?)', [communityIds[0],adminId,'Dashboard responsive','Construye una interfaz moderna usando HTML, CSS y JavaScript.','Intermedia','3 días',120,stamp]);
  await run('INSERT INTO community_challenges (community_id,user_id,title,description,difficulty,estimated_time,xp,created_at) VALUES (?,?,?,?,?,?,?,?)', [communityIds[0],adminId,'Consulta SQL avanzada','Resuelve una consulta con agrupaciones y subconsultas.','Básica','1 día',80,stamp]);

  const eventRows = [
    [demoId,null,'Examen de Algoritmos','Repasar complejidad y grafos','Personal',dateOnly(2),dateOnly(2),'09:00','#ff8f5b',0,'scheduled'],
    [demoId,null,'Entrega Proyecto Web','Subir repositorio y documentación','Personal',dateOnly(5),dateOnly(5),'23:00','#31c7d9',0,'scheduled'],
    [adminId,communityIds[0],'Web Seminar React','Sesión oficial sobre React','Webinar',dateOnly(4),dateOnly(4),'18:00','#4b8cff',1,'scheduled'],
    [luisId,communityIds[2],'Sesión general SQL','Consultas avanzadas y normalización','Sesión grupal',dateOnly(6),dateOnly(6),'16:00','#2dd4bf',0,'active'],
    [anaId,communityIds[1],'Hackathon Focurion','Reto colaborativo universitario','Evento oficial',dateOnly(12),dateOnly(13),'10:00','#a15cff',1,'scheduled'],
    [michelleId,communityIds[3],'Charla de Ciberseguridad','Solicitud pendiente de aprobación','Taller',dateOnly(15),dateOnly(15),'17:00','#ffb84b',0,'pending']
  ];
  for (const event of eventRows) await run('INSERT INTO events (user_id,community_id,title,description,type,start_date,end_date,start_time,color,is_official,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [...event,stamp]);

  await run('INSERT INTO moderation_reports (reporter_id,entity_type,entity_id,entity_name,reason,detail,status,created_at) VALUES (?,?,?,?,?,?,?,?)', [demoId,'user',jassielId,'Jassiel Jiménez','Lenguaje inapropiado','Comentario reportado por otro usuario.','pending',stamp]);
  await run('INSERT INTO moderation_reports (reporter_id,entity_type,entity_id,entity_name,reason,detail,status,created_at) VALUES (?,?,?,?,?,?,?,?)', [anaId,'community',communityIds[3],'UAS Tecnología','Validación pendiente','Revisar nombre, descripción y responsables.','pending',stamp]);
  await run('INSERT INTO moderation_reports (reporter_id,entity_type,entity_id,entity_name,reason,detail,status,created_at) VALUES (?,?,?,?,?,?,?,?)', [luisId,'room',roomIds[5],'Sala privada React','Revisión de categoría','La categoría no coincide con la descripción.','pending',stamp]);

  const settings = [
    ['admin_theme','dark'],['report_notifications','1'],['room_alerts','1'],['allow_registration','1'],['community_auto_approval','0']
  ];
  for (const item of settings) await run('INSERT INTO system_settings (setting_key,setting_value) VALUES (?,?)', item);
  await logActivity(adminId,'Inicializó la base de datos','system',null,'Datos demo creados para Focurion MySQL.');
}

async function ensureCommunityStarterContent(communityId, ownerId) {
  const stamp = now();
  const community = await one('SELECT name,category FROM communities WHERE id=?', [communityId]);
  if (!community) return;
  const members = await all(`SELECT u.id FROM community_members cm JOIN users u ON u.id=cm.user_id
    WHERE cm.community_id=? AND u.is_active=1 AND u.status='active' ORDER BY cm.joined_at,u.id`, [communityId]);
  const authorIds = members.map(member => member.id);
  if (!authorIds.includes(Number(ownerId))) authorIds.unshift(Number(ownerId));
  const starterPosts = [
    '¡Bienvenido a la comunidad! Usa este espacio para compartir dudas, avances y aprendizajes con otros estudiantes.',
    'Recurso de la semana: elige un tema que quieras dominar, comparte tu objetivo y registra aquí lo que vayas descubriendo.',
    `¿En qué están trabajando esta semana en ${community.name}? Comparte tu avance, aunque todavía esté en proceso, para que podamos intercambiar ideas.`,
    `Hilo abierto de dudas de ${community.category || 'tecnología'}: deja aquí ese concepto o problema que te está costando y entre todos buscamos una explicación clara.`,
    'Mini reto de la comunidad: explica en pocas líneas algo útil que aprendiste recientemente y deja un ejemplo que le pueda servir a otro estudiante.',
    '¿Tienes un recurso que realmente te haya servido? Comparte documentación, apuntes, repositorios o videos y cuéntanos por qué lo recomendarías.'
  ];
  const starterPostIds = [];
  for (let index = 0; index < starterPosts.length; index += 1) {
    const content = starterPosts[index];
    let existing = await one('SELECT id FROM posts WHERE community_id=? AND content=? LIMIT 1', [communityId, content]);
    if (!existing) {
      const authorId = authorIds[index % authorIds.length] || Number(ownerId);
      const result = await run('INSERT INTO posts (community_id,user_id,content,created_at) VALUES (?,?,?,?)', [communityId, authorId, content, stamp]);
      existing = { id:result.insertId };
    }
    starterPostIds.push(existing.id);
  }

  const starterComments = [
    'Buena idea. Yo empezaría por dividirlo en pasos pequeños y compartir el primer avance.',
    'Si alguien tiene un recurso o ejemplo sobre esto, estaría bien dejarlo aquí para compararlo.',
    'Me sirve este hilo. También podemos contar qué intentamos y qué parte fue la más complicada.'
  ];
  for (let index = 2; index < starterPostIds.length; index += 1) {
    const commentContent = starterComments[(index - 2) % starterComments.length];
    const postId = starterPostIds[index];
    const exists = await one('SELECT id FROM comments WHERE post_id=? AND content=? LIMIT 1', [postId, commentContent]);
    if (!exists) {
      const commentAuthor = authorIds[(index + 1) % authorIds.length] || Number(ownerId);
      await run('INSERT INTO comments (post_id,user_id,content,created_at) VALUES (?,?,?,?)', [postId, commentAuthor, commentContent, stamp]);
    }
  }

  const starterResources = [
    ['Guía de JavaScript en MDN','Conceptos y ejemplos para fortalecer tus bases.','https://developer.mozilla.org/es/docs/Web/JavaScript/Guide','notes'],
    ['Referencia práctica de CSS','Documentación de estilos, layouts y diseño responsive.','https://developer.mozilla.org/es/docs/Web/CSS','link'],
    ['Manual de MySQL','Consultas, modelado y administración de bases de datos.','https://dev.mysql.com/doc/','pdf']
  ];
  for (const resource of starterResources) {
    const existing = await one('SELECT id FROM community_resources WHERE community_id=? AND title=? LIMIT 1', [communityId, resource[0]]);
    if (!existing) {
      await run(
        'INSERT INTO community_resources (community_id,user_id,title,description,url,resource_type,created_at) VALUES (?,?,?,?,?,?,?)',
        [communityId, ownerId, ...resource, stamp]
      );
    }
  }

  const starterProjectTitle = 'Proyecto colaborativo inicial';
  if (!await one('SELECT id FROM community_projects WHERE community_id=? AND title=? LIMIT 1', [communityId, starterProjectTitle])) {
    await run(
      'INSERT INTO community_projects (community_id,user_id,title,description,stack,project_url,status,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [communityId, ownerId, starterProjectTitle, 'Presenta una idea, define tareas pequeñas y comparte avances con la comunidad.', 'HTML, CSS, JavaScript', '', 'development', stamp]
    );
  }

  const starterChallengeTitle = 'Comparte tu primer aprendizaje';
  if (!await one('SELECT id FROM community_challenges WHERE community_id=? AND title=? LIMIT 1', [communityId, starterChallengeTitle])) {
    await run(
      'INSERT INTO community_challenges (community_id,user_id,title,description,difficulty,estimated_time,xp,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [communityId, ownerId, starterChallengeTitle, 'Publica una explicación breve de algo nuevo que hayas aprendido y comenta una aportación de otro miembro.', 'Básica', '30 minutos', 40, stamp]
    );
  }
}

async function ensureStarterExperience(userId) {
  const memberships = await one('SELECT COUNT(*) AS total FROM community_members WHERE user_id=?', [userId]);
  if (Number(memberships?.total || 0) > 0) return;
  let starter = await one("SELECT id,owner_id FROM communities WHERE status='active' ORDER BY (name='UPSIN Tech') DESC,id ASC LIMIT 1");
  if (!starter) {
    const owner = await one("SELECT id FROM users WHERE role='admin' AND is_active=1 ORDER BY id LIMIT 1") || { id:userId };
    const result = await run(
      "INSERT INTO communities (owner_id,name,description,category,university,is_private,status,created_at) VALUES (?,?,?,?,?,0,'active',?)",
      [owner.id, 'Comunidad Focurion', 'Espacio inicial para aprender, compartir recursos y colaborar.', 'Tecnología', 'General', now()]
    );
    starter = { id:result.insertId, owner_id:owner.id };
  }
  await run('INSERT IGNORE INTO community_members (community_id,user_id,joined_at) VALUES (?,?,?)', [starter.id, userId, now()]);
  await ensureCommunityStarterContent(starter.id, starter.owner_id);
}

async function ensureStarterContentForExistingData() {
  const communities = await all("SELECT id,owner_id FROM communities WHERE status<>'suspended' ORDER BY id");
  for (const community of communities) await ensureCommunityStarterContent(community.id, community.owner_id);
  const users = await all("SELECT id FROM users WHERE is_active=1 AND status='active' ORDER BY id");
  for (const user of users) await ensureStarterExperience(user.id);
}

async function loadCommunityPosts(communityId, viewerId) {
  const posts = await all(`SELECT p.*,u.name,u.avatar_color,
    (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id=p.id) AS like_count,
    EXISTS(SELECT 1 FROM post_likes pl2 WHERE pl2.post_id=p.id AND pl2.user_id=?) AS liked,
    EXISTS(SELECT 1 FROM post_saves ps WHERE ps.post_id=p.id AND ps.user_id=?) AS saved
    FROM posts p JOIN users u ON u.id=p.user_id
    WHERE p.community_id=? AND p.status='visible' ORDER BY p.id DESC LIMIT 100`, [viewerId, viewerId, communityId]);
  for (const post of posts) {
    post.like_count = Number(post.like_count || 0);
    post.liked = Number(post.liked || 0);
    post.saved = Number(post.saved || 0);
    post.comments = await all(`SELECT c.*,u.name,u.avatar_color FROM comments c JOIN users u ON u.id=c.user_id
      WHERE c.post_id=? AND c.status='visible' ORDER BY c.id`, [post.id]);
  }
  return posts;
}

async function refreshDemoDates() {
  const marker = dateOnly();
  const savedMarker = await one("SELECT setting_value FROM system_settings WHERE setting_key='demo_dates_last_refresh'");
  if (savedMarker?.setting_value === marker) return;

  const users = await all("SELECT id,email FROM users WHERE email IN ('alumno@focurion.local','admin@focurion.local','ana@demo.local','luis@demo.local','michelle@demo.local')");
  const userIds = Object.fromEntries(users.map(user => [user.email, user.id]));
  const demoId = userIds['alumno@focurion.local'];
  if (demoId) {
    const taskDates = [
      ['Terminar práctica de React', 1],
      ['Repasar redes TCP/IP', 3],
      ['Estudiar algoritmos', 6]
    ];
    for (const [title, offset] of taskDates) {
      await run("UPDATE tasks SET due_date=? WHERE user_id=? AND title=? AND status='pending'", [dateOnly(offset), demoId, title]);
    }
    await run("UPDATE goals SET due_date=? WHERE user_id=? AND status='active'", [dateOnly(7), demoId]);
  }

  const demoEvents = [
    ['alumno@focurion.local','Examen de Algoritmos',2],
    ['alumno@focurion.local','Entrega Proyecto Web',5],
    ['admin@focurion.local','Web Seminar React',4],
    ['luis@demo.local','Sesión general SQL',6],
    ['ana@demo.local','Hackathon Focurion',12],
    ['michelle@demo.local','Charla de Ciberseguridad',15]
  ];
  for (const [email, title, offset] of demoEvents) {
    const userId = userIds[email];
    if (!userId) continue;
    const eventDate = dateOnly(offset);
    await run('UPDATE events SET start_date=?,end_date=? WHERE user_id=? AND title=?', [eventDate, eventDate, userId, title]);
  }
  await run(
    "INSERT INTO system_settings (setting_key,setting_value) VALUES ('demo_dates_last_refresh',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
    [marker]
  );
}

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'focurion-local-mysql-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 },
  proxy: process.env.NODE_ENV === 'production'
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Evita que el navegador reutilice respuestas antiguas de la API.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

function changedResourcesForRequest(req) {
  if (!req.path.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return [];
  if (req.path.startsWith('/api/auth/')) return [];

  const resources = new Set();
  const add = (...items) => items.forEach(item => resources.add(item));
  const route = req.path;

  if (route.startsWith('/api/tasks')) add('tasks', 'dashboard', 'ranking', 'admin-dashboard');
  if (route.startsWith('/api/goals')) add('goals', 'dashboard');
  if (route.startsWith('/api/notes')) add('notes');
  if (route.startsWith('/api/pomodoro')) add('dashboard', 'ranking', 'admin-reports');
  if (route.startsWith('/api/communities')) add('communities', 'posts', 'admin-communities', 'admin-dashboard', 'admin-reports');
  if (route.startsWith('/api/posts')) add('communities', 'posts', 'admin-communities', 'admin-reports');
  if (route.startsWith('/api/rooms')) add('rooms', 'admin-rooms', 'admin-dashboard', 'admin-reports');
  if (route.startsWith('/api/events')) add('events', 'dashboard', 'admin-events', 'admin-dashboard');
  if (route === '/api/me' || route.startsWith('/api/me/')) add('profile', 'settings', 'dashboard', 'ranking', 'admin-users');

  if (route.startsWith('/api/admin/users')) add('admin-users', 'admin-dashboard', 'ranking');
  if (route.startsWith('/api/admin/communities')) add('communities', 'admin-communities', 'admin-dashboard', 'admin-reports');
  if (route.startsWith('/api/admin/rooms')) add('rooms', 'admin-rooms', 'admin-dashboard', 'admin-reports');
  if (route.startsWith('/api/admin/events')) add('events', 'dashboard', 'admin-events', 'admin-dashboard');
  if (route.startsWith('/api/admin/moderation')) add('admin-moderation', 'admin-dashboard');
  if (route.startsWith('/api/admin/settings')) add('admin-settings');

  return [...resources];
}

// Publica cambios por Socket.IO. Así cualquier pestaña abierta refleja altas,
// ediciones y eliminaciones sin recargar manualmente la página.
app.use((req, res, next) => {
  const resources = changedResourcesForRequest(req);
  if (!resources.length) return next();

  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    io.emit('data:changed', {
      resources,
      userId: req.session?.userId || null,
      method: req.method,
      path: req.path,
      changedAt: Date.now()
    });
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

const requireAuth = asyncHandler(async (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Debes iniciar sesión.' });
  const user = await one('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!user || !Number(user.is_active) || user.status === 'suspended') {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'La sesión ya no es válida.' });
  }
  req.user = user;
  await run('UPDATE users SET last_active = ? WHERE id = ?', [now(), user.id]);
  next();
});

const requireAdmin = asyncHandler(async (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Debes iniciar sesión.' });
  const user = await one('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!user || !Number(user.is_active) || user.status === 'suspended') {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'La sesión ya no es válida.' });
  }
  if (!['admin','moderator'].includes(user.role)) return res.status(403).json({ error: 'Acceso exclusivo para administración.' });
  req.user = user;
  await run('UPDATE users SET last_active = ? WHERE id = ?', [now(), user.id]);
  next();
});

app.get('/api/health', asyncHandler(async (req, res) => {
  const db = await one('SELECT DATABASE() AS name');
  res.json({ ok: true, app: 'Focurion', database: db.name, mysqlPort: activeDbPort, platform: process.platform, time: now() });
}));

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const registrationSetting = await one("SELECT setting_value FROM system_settings WHERE setting_key='allow_registration'");
  if (registrationSetting && registrationSetting.setting_value === '0') return res.status(403).json({ error: 'Los registros nuevos están desactivados temporalmente.' });
  const name = text(req.body.name, 80);
  const email = text(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  const university = text(req.body.university || 'UPSIN', 80);
  const career = text(req.body.career || 'Ingeniería en Tecnologías de la Información', 120);
  if (name.length < 2) return res.status(400).json({ error: 'Escribe tu nombre completo.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'El correo no es válido.' });
  if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  try {
    const result = await run(
      `INSERT INTO users (name,email,password_hash,university,career,role,status,is_active,xp,streak,created_at,last_active)
       VALUES (?,?,?,?,?,'student','active',1,0,1,?,?)`,
      [name,email,bcrypt.hashSync(password,10),university,career,now(),now()]
    );
    await ensureStarterExperience(result.insertId);
    req.session.userId = result.insertId;
    await logActivity(result.insertId,'Nuevo registro','user',result.insertId,`${name} creó una cuenta.`);
    res.status(201).json({ user: publicUser(await one('SELECT * FROM users WHERE id=?',[result.insertId])) });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese correo ya está registrado.' });
    throw error;
  }
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const email = text(req.body.email, 120).toLowerCase();
  const attemptKey = loginAttemptKey(req, email);
  const attempt = getLoginAttempt(attemptKey);
  if (attempt?.count >= LOGIN_MAX_ATTEMPTS) {
    const seconds = Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (Date.now() - attempt.startedAt)) / 1000));
    res.setHeader('Retry-After', String(seconds));
    return res.status(429).json({ error: `Demasiados intentos. Vuelve a probar en ${Math.ceil(seconds / 60)} min.` });
  }
  const user = await one('SELECT * FROM users WHERE email=?',[email]);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    recordLoginFailure(attemptKey);
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  if (!Number(user.is_active) || user.status === 'suspended') return res.status(403).json({ error: 'La cuenta está suspendida.' });
  loginAttempts.delete(attemptKey);
  req.session.userId = user.id;
  await run('UPDATE users SET last_active=? WHERE id=?',[now(),user.id]);
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/forgot-password', asyncHandler(async (req, res) => {
  const email = text(req.body.email, 120).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error:'Escribe un correo válido.' });
  const user = await one('SELECT id,name,email FROM users WHERE email=?', [email]);
  const generic = { message:'Si el correo está registrado, recibirás un código con vigencia de 15 minutos.' };
  if (!user) return res.json(generic);
  const recent = await one('SELECT created_at FROM password_reset_codes WHERE user_id=? ORDER BY id DESC LIMIT 1', [user.id]);
  if (recent && Date.now() - new Date(recent.created_at).getTime() < 60000) {
    return res.status(429).json({ error:'Espera un minuto antes de solicitar otro código.' });
  }
  await run('UPDATE password_reset_codes SET used_at=? WHERE user_id=? AND used_at IS NULL', [now(), user.id]);
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
  await run('INSERT INTO password_reset_codes (user_id,code_hash,expires_at,created_at) VALUES (?,?,?,?)', [user.id,bcrypt.hashSync(code,10),expiresAt,now()]);
  const delivery = await deliverResetCode(user, code);
  res.json({ ...generic, emailDelivered:delivery.delivered, developmentCode:delivery.developmentCode || undefined });
}));

app.post('/api/auth/reset-password', asyncHandler(async (req, res) => {
  const email = text(req.body.email, 120).toLowerCase();
  const code = text(req.body.code, 6);
  const newPassword = String(req.body.newPassword || '');
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error:'El código debe tener 6 dígitos.' });
  if (newPassword.length < 8) return res.status(400).json({ error:'La nueva contraseña debe tener al menos 8 caracteres.' });
  const user = await one('SELECT id FROM users WHERE email=?', [email]);
  if (!user) return res.status(400).json({ error:'El código no es válido o ya venció.' });
  const reset = await one('SELECT * FROM password_reset_codes WHERE user_id=? AND used_at IS NULL ORDER BY id DESC LIMIT 1', [user.id]);
  if (!reset || new Date(reset.expires_at).getTime() < Date.now() || !bcrypt.compareSync(code, reset.code_hash)) {
    return res.status(400).json({ error:'El código no es válido o ya venció.' });
  }
  await run('UPDATE users SET password_hash=? WHERE id=?', [bcrypt.hashSync(newPassword,10),user.id]);
  await run('UPDATE password_reset_codes SET used_at=? WHERE id=?', [now(),reset.id]);
  await logActivity(user.id,'Restableció su contraseña','user',user.id,'Recuperación desde el inicio de sesión.');
  res.json({ message:'Contraseña actualizada. Ya puedes iniciar sesión.' });
}));

app.post('/api/auth/logout', requireAuth, (req, res) => req.session.destroy(() => res.json({ ok:true })));
app.get('/api/me', requireAuth, (req,res) => res.json({ user:publicUser(req.user) }));

app.patch('/api/me', requireAuth, asyncHandler(async (req,res) => {
  const allowed = {
    name:text(req.body.name ?? req.user.name,80) || req.user.name,
    university:text(req.body.university ?? req.user.university,80),
    career:text(req.body.career ?? req.user.career,120),
    theme:['dark','light'].includes(req.body.theme) ? req.body.theme : req.user.theme,
    language:text(req.body.language ?? req.user.language,8),
    timezone:text(req.body.timezone ?? req.user.timezone,80),
    pomodoro_minutes:Math.min(90,Math.max(1,number(req.body.pomodoro_minutes,req.user.pomodoro_minutes))),
    short_break_minutes:Math.min(30,Math.max(0,number(req.body.short_break_minutes,req.user.short_break_minutes))),
    long_break_minutes:Math.min(60,Math.max(0,number(req.body.long_break_minutes,req.user.long_break_minutes))),
    weekly_goal_hours:Math.min(80,Math.max(1,number(req.body.weekly_goal_hours,req.user.weekly_goal_hours))),
    notifications:req.body.notifications === undefined ? req.user.notifications : (bool(req.body.notifications) ? 1 : 0)
  };
  await run(`UPDATE users SET name=?,university=?,career=?,theme=?,language=?,timezone=?,pomodoro_minutes=?,short_break_minutes=?,long_break_minutes=?,weekly_goal_hours=?,notifications=? WHERE id=?`, [...Object.values(allowed),req.user.id]);
  res.json({ user:publicUser(await one('SELECT * FROM users WHERE id=?',[req.user.id])) });
}));

app.post('/api/me/password', requireAuth, asyncHandler(async (req,res) => {
  if (!bcrypt.compareSync(String(req.body.currentPassword || ''),req.user.password_hash)) return res.status(400).json({ error:'La contraseña actual no coincide.' });
  const next = String(req.body.newPassword || '');
  if (next.length < 8) return res.status(400).json({ error:'La nueva contraseña debe tener al menos 8 caracteres.' });
  await run('UPDATE users SET password_hash=? WHERE id=?',[bcrypt.hashSync(next,10),req.user.id]);
  res.json({ ok:true });
}));

app.get('/api/dashboard', requireAuth, asyncHandler(async (req,res) => {
  const [tasks,goals,events,rooms,ranking,studyRow,completedRow] = await Promise.all([
    all('SELECT * FROM tasks WHERE user_id=? ORDER BY status, due_date IS NULL, due_date, id DESC',[req.user.id]),
    all('SELECT * FROM goals WHERE user_id=? ORDER BY status,id DESC',[req.user.id]),
    all(`SELECT e.*, c.name AS community_name FROM events e LEFT JOIN communities c ON c.id=e.community_id
         WHERE (e.user_id=? OR (e.is_official=1 AND e.status IN ('scheduled','active'))) ORDER BY e.start_date,e.start_time LIMIT 12`,[req.user.id]),
    all(`SELECT r.*, COUNT(DISTINCT rm.user_id) AS members,
         MAX(CASE WHEN rm.user_id=? THEN 1 ELSE 0 END) AS joined
         FROM rooms r LEFT JOIN room_members rm ON rm.room_id=r.id WHERE r.status='active'
         GROUP BY r.id ORDER BY members DESC,r.id DESC LIMIT 8`,[req.user.id]),
    all(`SELECT id,name,university,xp,streak,avatar_color FROM users WHERE is_active=1 AND status='active' ORDER BY xp DESC,streak DESC LIMIT 5`),
    one('SELECT COALESCE(SUM(duration_minutes),0) AS minutes FROM pomodoro_sessions WHERE user_id=? AND completed=1',[req.user.id]),
    one("SELECT COUNT(*) AS total FROM tasks WHERE user_id=? AND status='completed'",[req.user.id])
  ]);
  const studyMinutes = Number(studyRow.minutes || 0);
  const completedTasks = Number(completedRow.total || 0);
  const goalMinutes = Math.max(60,Number(req.user.weekly_goal_hours || 12) * 60);
  const productivity = Math.min(100,Math.round((studyMinutes / goalMinutes) * 70 + Math.min(completedTasks,6) / 6 * 30));
  res.json({
    metrics:{ productivity,studyMinutes,completedTasks,streak:Number(req.user.streak),xp:Number(req.user.xp) },
    tasks,goals,events,rooms,ranking
  });
}));

app.get('/api/search', requireAuth, asyncHandler(async (req,res) => {
  const query=text(req.query.q,120).trim();
  if(query.length<2)return res.json({query,results:[]});
  const like=`%${query}%`;
  const admin=['admin','moderator'].includes(req.user.role);
  if(admin){
    const [users,communities,rooms,events,reports]=await Promise.all([
      all('SELECT id,name,email,university,career,role,status FROM users WHERE name LIKE ? OR email LIKE ? OR university LIKE ? OR career LIKE ? ORDER BY status,name LIMIT 10',[like,like,like,like]),
      all('SELECT id,name,description,university,category,status FROM communities WHERE name LIKE ? OR description LIKE ? OR university LIKE ? OR category LIKE ? ORDER BY status,name LIMIT 10',[like,like,like,like]),
      all('SELECT id,name,topic,description,category,status FROM rooms WHERE name LIKE ? OR topic LIKE ? OR description LIKE ? OR category LIKE ? ORDER BY status,name LIMIT 10',[like,like,like,like]),
      all('SELECT id,title,description,type,start_date,status FROM events WHERE title LIKE ? OR description LIKE ? OR type LIKE ? OR start_date LIKE ? ORDER BY start_date DESC LIMIT 10',[like,like,like,like]),
      all('SELECT id,entity_type,entity_name,reason,status FROM moderation_reports WHERE entity_name LIKE ? OR reason LIKE ? OR entity_type LIKE ? ORDER BY id DESC LIMIT 8',[like,like,like])
    ]);
    const results=[
      ...users.map(item=>({kind:'user',id:item.id,title:item.name,subtitle:`${item.email} · ${item.university} · ${item.status}`})),
      ...communities.map(item=>({kind:'community',id:item.id,title:item.name,subtitle:`${item.university} · ${item.category} · ${item.status}`})),
      ...rooms.map(item=>({kind:'room',id:item.id,title:item.name,subtitle:`${item.topic} · ${item.category} · ${item.status}`})),
      ...events.map(item=>({kind:'event',id:item.id,title:item.title,subtitle:`${item.type} · ${item.start_date} · ${item.status}`,start_date:item.start_date})),
      ...reports.map(item=>({kind:'report',id:item.id,title:item.entity_name,subtitle:`${item.entity_type} · ${item.reason} · ${item.status}`}))
    ];
    return res.json({query,results:results.slice(0,36)});
  }

  const [tasks,goals,notes,rooms,communities,events,users,resources,projects,challenges]=await Promise.all([
    all('SELECT id,title,description,due_date,status FROM tasks WHERE user_id=? AND (title LIKE ? OR description LIKE ? OR due_date LIKE ?) ORDER BY status,id DESC LIMIT 8',[req.user.id,like,like,like]),
    all('SELECT id,title,unit,due_date,status FROM goals WHERE user_id=? AND (title LIKE ? OR unit LIKE ? OR due_date LIKE ?) ORDER BY status,id DESC LIMIT 6',[req.user.id,like,like,like]),
    all('SELECT id,title,LEFT(content,160) AS excerpt FROM notes WHERE user_id=? AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC LIMIT 6',[req.user.id,like,like]),
    all(`SELECT r.id,r.name,r.topic,r.description,r.category,MAX(CASE WHEN rm.user_id=? THEN 1 ELSE 0 END) AS joined FROM rooms r LEFT JOIN room_members rm ON rm.room_id=r.id WHERE (r.status='active' OR r.owner_id=?) AND (r.name LIKE ? OR r.topic LIKE ? OR r.description LIKE ? OR r.category LIKE ?) GROUP BY r.id ORDER BY joined DESC,r.id DESC LIMIT 8`,[req.user.id,req.user.id,like,like,like,like]),
    all(`SELECT c.id,c.name,c.description,c.university,c.category,MAX(CASE WHEN cm.user_id=? THEN 1 ELSE 0 END) AS joined FROM communities c LEFT JOIN community_members cm ON cm.community_id=c.id WHERE (c.status='active' OR c.owner_id=?) AND (c.name LIKE ? OR c.description LIKE ? OR c.university LIKE ? OR c.category LIKE ?) GROUP BY c.id ORDER BY joined DESC,c.id DESC LIMIT 8`,[req.user.id,req.user.id,like,like,like,like]),
    all(`SELECT id,title,description,type,start_date FROM events WHERE (user_id=? OR (is_official=1 AND status IN ('scheduled','active'))) AND (title LIKE ? OR description LIKE ? OR type LIKE ? OR start_date LIKE ?) ORDER BY start_date DESC LIMIT 8`,[req.user.id,like,like,like,like]),
    all("SELECT id,name,university,career,xp FROM users WHERE is_active=1 AND status='active' AND (name LIKE ? OR university LIKE ? OR career LIKE ?) ORDER BY xp DESC LIMIT 6",[like,like,like]),
    all(`SELECT cr.id,cr.community_id,cr.title,cr.description,cr.resource_type,c.name AS community_name FROM community_resources cr JOIN communities c ON c.id=cr.community_id JOIN community_members cm ON cm.community_id=cr.community_id AND cm.user_id=? WHERE cr.title LIKE ? OR cr.description LIKE ? OR cr.resource_type LIKE ? ORDER BY cr.id DESC LIMIT 6`,[req.user.id,like,like,like]),
    all(`SELECT cp.id,cp.community_id,cp.title,cp.description,cp.stack,c.name AS community_name FROM community_projects cp JOIN communities c ON c.id=cp.community_id JOIN community_members cm ON cm.community_id=cp.community_id AND cm.user_id=? WHERE cp.title LIKE ? OR cp.description LIKE ? OR cp.stack LIKE ? ORDER BY cp.id DESC LIMIT 6`,[req.user.id,like,like,like]),
    all(`SELECT cc.id,cc.community_id,cc.title,cc.description,cc.difficulty,c.name AS community_name FROM community_challenges cc JOIN communities c ON c.id=cc.community_id JOIN community_members cm ON cm.community_id=cc.community_id AND cm.user_id=? WHERE cc.title LIKE ? OR cc.description LIKE ? OR cc.difficulty LIKE ? ORDER BY cc.id DESC LIMIT 6`,[req.user.id,like,like,like])
  ]);
  const results=[
    ...tasks.map(item=>({kind:'task',id:item.id,title:item.title,subtitle:`Tarea · ${item.description||item.due_date||item.status}`})),
    ...events.map(item=>({kind:'event',id:item.id,title:item.title,subtitle:`Evento · ${item.type} · ${item.start_date}`,start_date:item.start_date})),
    ...rooms.map(item=>({kind:'room',id:item.id,title:item.name,subtitle:`Sala · ${item.topic||item.category}`,joined:Number(item.joined)})),
    ...communities.map(item=>({kind:'community',id:item.id,title:item.name,subtitle:`Comunidad · ${item.university} · ${item.category}`,joined:Number(item.joined)})),
    ...goals.map(item=>({kind:'goal',id:item.id,title:item.title,subtitle:`Meta · ${item.unit}${item.due_date?' · '+item.due_date:''}`})),
    ...notes.map(item=>({kind:'note',id:item.id,title:item.title,subtitle:`Nota · ${item.excerpt||'Sin contenido'}`})),
    ...resources.map(item=>({kind:'resource',id:item.id,community_id:item.community_id,title:item.title,subtitle:`Recurso · ${item.resource_type} · ${item.community_name}`,tab:'resources'})),
    ...projects.map(item=>({kind:'project',id:item.id,community_id:item.community_id,title:item.title,subtitle:`Proyecto · ${item.stack||item.community_name}`,tab:'projects'})),
    ...challenges.map(item=>({kind:'challenge',id:item.id,community_id:item.community_id,title:item.title,subtitle:`Reto · ${item.difficulty} · ${item.community_name}`,tab:'challenges'})),
    ...users.map(item=>({kind:'user',id:item.id,title:item.name,subtitle:`Usuario · ${item.university} · ${item.career}`}))
  ];
  res.json({query,results:results.slice(0,40)});
}));

app.get('/api/tasks', requireAuth, asyncHandler(async (req,res) => res.json({ tasks:await all('SELECT * FROM tasks WHERE user_id=? ORDER BY status,due_date IS NULL,due_date,id DESC',[req.user.id]) })));
app.post('/api/tasks', requireAuth, asyncHandler(async (req,res) => {
  const title=text(req.body.title,160); if(!title) return res.status(400).json({error:'Escribe el título de la tarea.'});
  const dueDate=text(req.body.due_date,10)||null; if(dueDate&&!isDateOnly(dueDate))return res.status(400).json({error:'La fecha límite no es válida.'});
  const priority=['low','medium','high'].includes(req.body.priority)?req.body.priority:'medium';
  const result=await run('INSERT INTO tasks (user_id,title,description,due_date,priority,status,created_at) VALUES (?,?,?,?,?,\'pending\',?)',[req.user.id,title,text(req.body.description,1000),dueDate,priority,now()]);
  res.status(201).json({task:await one('SELECT * FROM tasks WHERE id=?',[result.insertId])});
}));
app.patch('/api/tasks/:id', requireAuth, asyncHandler(async (req,res) => {
  const task=await one('SELECT * FROM tasks WHERE id=? AND user_id=?',[req.params.id,req.user.id]); if(!task)return res.status(404).json({error:'Tarea no encontrada.'});
  const status=['pending','completed'].includes(req.body.status)?req.body.status:task.status;
  const dueDate=text(req.body.due_date??task.due_date,10)||null; if(dueDate&&!isDateOnly(dueDate))return res.status(400).json({error:'La fecha límite no es válida.'});
  await run('UPDATE tasks SET title=?,description=?,due_date=?,priority=?,status=?,completed_at=? WHERE id=? AND user_id=?',[text(req.body.title??task.title,160)||task.title,text(req.body.description??task.description,1000),dueDate,['low','medium','high'].includes(req.body.priority)?req.body.priority:task.priority,status,status==='completed'?(task.completed_at||now()):null,task.id,req.user.id]);
  if(task.status!=='completed'&&status==='completed')await addXp(req.user.id,20);
  res.json({task:await one('SELECT * FROM tasks WHERE id=?',[task.id])});
}));
app.delete('/api/tasks/:id', requireAuth, asyncHandler(async (req,res) => { const result=await run('DELETE FROM tasks WHERE id=? AND user_id=?',[req.params.id,req.user.id]); res.status(result.affectedRows?200:404).json(result.affectedRows?{ok:true}:{error:'Tarea no encontrada.'}); }));

app.get('/api/goals', requireAuth, asyncHandler(async (req,res) => res.json({goals:await all('SELECT * FROM goals WHERE user_id=? ORDER BY status,id DESC',[req.user.id])})));
app.post('/api/goals', requireAuth, asyncHandler(async (req,res) => {
  const title=text(req.body.title,160); if(!title)return res.status(400).json({error:'Escribe el título de la meta.'});
  const dueDate=text(req.body.due_date,10)||null; if(dueDate&&!isDateOnly(dueDate))return res.status(400).json({error:'La fecha límite no es válida.'});
  const target=Math.max(1,number(req.body.target,1)); const current=Math.max(0,number(req.body.current,0)); const status=current>=target?'completed':'active';
  const result=await run('INSERT INTO goals (user_id,title,target,current,unit,due_date,status,created_at) VALUES (?,?,?,?,?,?,?,?)',[req.user.id,title,target,current,text(req.body.unit,40)||'sesiones',dueDate,status,now()]);
  res.status(201).json({goal:await one('SELECT * FROM goals WHERE id=?',[result.insertId])});
}));
app.patch('/api/goals/:id', requireAuth, asyncHandler(async (req,res) => {
  const goal=await one('SELECT * FROM goals WHERE id=? AND user_id=?',[req.params.id,req.user.id]); if(!goal)return res.status(404).json({error:'Meta no encontrada.'});
  const dueDate=text(req.body.due_date??goal.due_date,10)||null; if(dueDate&&!isDateOnly(dueDate))return res.status(400).json({error:'La fecha límite no es válida.'});
  const target=Math.max(1,number(req.body.target,goal.target)); const current=Math.max(0,number(req.body.current,goal.current)); const status=current>=target?'completed':'active';
  await run('UPDATE goals SET title=?,target=?,current=?,unit=?,due_date=?,status=? WHERE id=? AND user_id=?',[text(req.body.title??goal.title,160)||goal.title,target,current,text(req.body.unit??goal.unit,40)||goal.unit,dueDate,status,goal.id,req.user.id]);
  if(goal.status!=='completed'&&status==='completed')await addXp(req.user.id,30);
  res.json({goal:await one('SELECT * FROM goals WHERE id=?',[goal.id])});
}));
app.delete('/api/goals/:id', requireAuth, asyncHandler(async (req,res) => {const result=await run('DELETE FROM goals WHERE id=? AND user_id=?',[req.params.id,req.user.id]);res.status(result.affectedRows?200:404).json(result.affectedRows?{ok:true}:{error:'Meta no encontrada.'});}));

app.get('/api/notes', requireAuth, asyncHandler(async (req,res)=>res.json({notes:await all('SELECT * FROM notes WHERE user_id=? ORDER BY updated_at DESC',[req.user.id])})));
app.post('/api/notes', requireAuth, asyncHandler(async (req,res)=>{const result=await run('INSERT INTO notes (user_id,title,content,created_at,updated_at) VALUES (?,?,?,?,?)',[req.user.id,text(req.body.title,160)||'Nueva nota',text(req.body.content,20000),now(),now()]);res.status(201).json({note:await one('SELECT * FROM notes WHERE id=?',[result.insertId])});}));
app.patch('/api/notes/:id', requireAuth, asyncHandler(async (req,res)=>{const note=await one('SELECT * FROM notes WHERE id=? AND user_id=?',[req.params.id,req.user.id]);if(!note)return res.status(404).json({error:'Nota no encontrada.'});await run('UPDATE notes SET title=?,content=?,updated_at=? WHERE id=? AND user_id=?',[text(req.body.title??note.title,160)||'Sin título',text(req.body.content??note.content,20000),now(),note.id,req.user.id]);res.json({note:await one('SELECT * FROM notes WHERE id=?',[note.id])});}));
app.delete('/api/notes/:id', requireAuth, asyncHandler(async (req,res)=>{const result=await run('DELETE FROM notes WHERE id=? AND user_id=?',[req.params.id,req.user.id]);res.status(result.affectedRows?200:404).json(result.affectedRows?{ok:true}:{error:'Nota no encontrada.'});}));

app.post('/api/pomodoro/complete', requireAuth, asyncHandler(async (req,res)=>{const duration=Math.min(180,Math.max(1,number(req.body.duration_minutes,req.user.pomodoro_minutes)));const stamp=now();const started=new Date(Date.now()-duration*60000).toISOString();await run('INSERT INTO pomodoro_sessions (user_id,task_id,duration_minutes,completed,started_at,ended_at) VALUES (?,?,?,?,?,?)',[req.user.id,req.body.task_id||null,duration,1,started,stamp]);await addXp(req.user.id,Math.max(10,Math.round(duration/2)));res.json({ok:true,xp:Math.max(10,Math.round(duration/2))});}));

app.get('/api/rooms', requireAuth, asyncHandler(async (req,res)=>{
  const rooms=await all(`SELECT r.*,c.name AS community_name,u.name AS owner_name,COUNT(DISTINCT rm.user_id) AS members,
    MAX(CASE WHEN rm.user_id=? THEN 1 ELSE 0 END) AS joined
    FROM rooms r JOIN users u ON u.id=r.owner_id LEFT JOIN communities c ON c.id=r.community_id LEFT JOIN room_members rm ON rm.room_id=r.id
    WHERE r.status='active' OR r.owner_id=? GROUP BY r.id ORDER BY r.status='active' DESC,members DESC,r.id DESC`,[req.user.id,req.user.id]);
  res.json({rooms});
}));
app.post('/api/rooms', requireAuth, asyncHandler(async (req,res)=>{const name=text(req.body.name,120);if(!name)return res.status(400).json({error:'Escribe el nombre de la sala.'});const result=await run('INSERT INTO rooms (owner_id,community_id,name,topic,description,category,capacity,is_private,access_code,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,\'active\',?)',[req.user.id,req.body.community_id||null,name,text(req.body.topic,80)||'General',text(req.body.description,1200),text(req.body.category,80)||text(req.body.topic,80)||'General',Math.min(500,Math.max(2,number(req.body.capacity,30))),bool(req.body.is_private)?1:0,text(req.body.access_code,80),now()]);await run('INSERT IGNORE INTO room_members (room_id,user_id,joined_at) VALUES (?,?,?)',[result.insertId,req.user.id,now()]);res.status(201).json({room:await one('SELECT * FROM rooms WHERE id=?',[result.insertId])});}));
app.post('/api/rooms/:id/join', requireAuth, asyncHandler(async (req,res)=>{const room=await one('SELECT * FROM rooms WHERE id=? AND status=\'active\'',[req.params.id]);if(!room)return res.status(404).json({error:'Sala no disponible.'});if(Number(room.is_private)&&text(req.body.access_code,80)!==room.access_code)return res.status(403).json({error:'Código de acceso incorrecto.'});const count=await one('SELECT COUNT(*) AS total FROM room_members WHERE room_id=?',[room.id]);if(Number(count.total)>=Number(room.capacity))return res.status(409).json({error:'La sala está llena.'});await run('INSERT IGNORE INTO room_members (room_id,user_id,joined_at) VALUES (?,?,?)',[room.id,req.user.id,now()]);res.json({ok:true});}));
app.get('/api/rooms/:id/messages', requireAuth, asyncHandler(async (req,res)=>{const member=await one('SELECT 1 AS ok FROM room_members WHERE room_id=? AND user_id=?',[req.params.id,req.user.id]);if(!member)return res.status(403).json({error:'Primero debes unirte a la sala.'});const messages=await all('SELECT m.*,u.name,u.avatar_color FROM room_messages m JOIN users u ON u.id=m.user_id WHERE m.room_id=? ORDER BY m.id ASC LIMIT 200',[req.params.id]);res.json({messages});}));
app.get('/api/rooms/:id/detail', requireAuth, asyncHandler(async (req,res)=>{
  const member=await one('SELECT 1 AS ok FROM room_members WHERE room_id=? AND user_id=?',[req.params.id,req.user.id]);
  if(!member)return res.status(403).json({error:'Primero debes unirte a la sala.'});
  const room=await one(`SELECT r.*,u.name AS owner_name,c.name AS community_name,COUNT(DISTINCT rm.user_id) AS members FROM rooms r JOIN users u ON u.id=r.owner_id LEFT JOIN communities c ON c.id=r.community_id LEFT JOIN room_members rm ON rm.room_id=r.id WHERE r.id=? GROUP BY r.id`,[req.params.id]);
  if(!room)return res.status(404).json({error:'Sala no encontrada.'});
  const [members,objectives,resources,messages]=await Promise.all([
    all(`SELECT u.id,u.name,u.university,u.career,u.avatar_color,u.last_active,rm.joined_at FROM room_members rm JOIN users u ON u.id=rm.user_id WHERE rm.room_id=? ORDER BY u.last_active DESC LIMIT 100`,[room.id]),
    all(`SELECT ro.*,u.name,u.avatar_color FROM room_objectives ro JOIN users u ON u.id=ro.user_id WHERE ro.room_id=? ORDER BY ro.id`,[room.id]),
    all(`SELECT rr.*,u.name FROM room_resources rr JOIN users u ON u.id=rr.user_id WHERE rr.room_id=? ORDER BY rr.id DESC`,[room.id]),
    all('SELECT m.*,u.name,u.avatar_color FROM room_messages m JOIN users u ON u.id=m.user_id WHERE m.room_id=? ORDER BY m.id ASC LIMIT 200',[room.id])
  ]);
  res.json({room,members,objectives,resources,messages});
}));
app.post('/api/rooms/:id/leave', requireAuth, asyncHandler(async (req,res)=>{await run('DELETE FROM room_members WHERE room_id=? AND user_id=?',[req.params.id,req.user.id]);res.json({ok:true});}));
app.post('/api/rooms/:id/objectives', requireAuth, asyncHandler(async (req,res)=>{const member=await one('SELECT 1 AS ok FROM room_members WHERE room_id=? AND user_id=?',[req.params.id,req.user.id]);if(!member)return res.status(403).json({error:'Únete a la sala para agregar objetivos.'});const content=text(req.body.content,240);if(!content)return res.status(400).json({error:'Escribe un objetivo.'});const result=await run('INSERT INTO room_objectives (room_id,user_id,content,created_at) VALUES (?,?,?,?)',[req.params.id,req.user.id,content,now()]);res.status(201).json({objective:await one('SELECT * FROM room_objectives WHERE id=?',[result.insertId])});}));
app.patch('/api/rooms/:roomId/objectives/:id', requireAuth, asyncHandler(async (req,res)=>{const result=await run('UPDATE room_objectives SET completed=? WHERE id=? AND room_id=? AND user_id=?',[bool(req.body.completed)?1:0,req.params.id,req.params.roomId,req.user.id]);res.status(result.affectedRows?200:404).json(result.affectedRows?{ok:true}:{error:'Objetivo no encontrado.'});}));
app.post('/api/rooms/:id/resources', requireAuth, asyncHandler(async (req,res)=>{const member=await one('SELECT 1 AS ok FROM room_members WHERE room_id=? AND user_id=?',[req.params.id,req.user.id]);if(!member)return res.status(403).json({error:'Únete a la sala para compartir recursos.'});const title=text(req.body.title,160),url=text(req.body.url,1000);if(!title||!/^https?:\/\//i.test(url))return res.status(400).json({error:'Escribe un título y una URL válida que comience con http.'});const type=['link','document','repository','video'].includes(req.body.resource_type)?req.body.resource_type:'link';const result=await run('INSERT INTO room_resources (room_id,user_id,title,url,resource_type,created_at) VALUES (?,?,?,?,?,?)',[req.params.id,req.user.id,title,url,type,now()]);res.status(201).json({resource:await one('SELECT * FROM room_resources WHERE id=?',[result.insertId])});}));

app.get('/api/communities', requireAuth, asyncHandler(async (req,res)=>{const communities=await all(`SELECT c.*,u.name AS owner_name,COUNT(DISTINCT cm.user_id) AS members,COUNT(DISTINCT p.id) AS posts,
  MAX(CASE WHEN cm.user_id=? THEN 1 ELSE 0 END) AS joined FROM communities c JOIN users u ON u.id=c.owner_id
  LEFT JOIN community_members cm ON cm.community_id=c.id LEFT JOIN posts p ON p.community_id=c.id AND p.status='visible'
  WHERE c.status='active' OR c.owner_id=? GROUP BY c.id ORDER BY members DESC,c.id DESC`,[req.user.id,req.user.id]);res.json({communities});}));
app.post('/api/communities', requireAuth, asyncHandler(async (req,res)=>{const name=text(req.body.name,120);if(!name)return res.status(400).json({error:'Escribe el nombre de la comunidad.'});const approval=await one("SELECT setting_value FROM system_settings WHERE setting_key='community_auto_approval'");const status=approval?.setting_value==='1'?'active':'pending';const result=await run('INSERT INTO communities (owner_id,name,description,category,university,is_private,status,created_at) VALUES (?,?,?,?,?,?,?,?)',[req.user.id,name,text(req.body.description,1200),text(req.body.category,80)||'Tecnología',text(req.body.university,80)||req.user.university,bool(req.body.is_private)?1:0,status,now()]);await run('INSERT IGNORE INTO community_members (community_id,user_id,joined_at) VALUES (?,?,?)',[result.insertId,req.user.id,now()]);await ensureCommunityStarterContent(result.insertId,req.user.id);res.status(201).json({community:await one('SELECT * FROM communities WHERE id=?',[result.insertId])});}));
app.post('/api/communities/:id/join', requireAuth, asyncHandler(async (req,res)=>{const community=await one('SELECT * FROM communities WHERE id=? AND status=\'active\'',[req.params.id]);if(!community)return res.status(404).json({error:'Comunidad no disponible.'});await run('INSERT IGNORE INTO community_members (community_id,user_id,joined_at) VALUES (?,?,?)',[community.id,req.user.id,now()]);res.json({ok:true});}));
app.get('/api/communities/:id/posts', requireAuth, asyncHandler(async (req,res)=>{const community=await one(`SELECT c.*,u.name AS owner_name,COUNT(DISTINCT cm_all.user_id) AS members,COUNT(DISTINCT p_all.id) AS posts FROM communities c JOIN users u ON u.id=c.owner_id LEFT JOIN community_members cm_all ON cm_all.community_id=c.id LEFT JOIN posts p_all ON p_all.community_id=c.id AND p_all.status='visible' WHERE c.id=? GROUP BY c.id`,[req.params.id]);if(!community)return res.status(404).json({error:'Comunidad no encontrada.'});const member=await one('SELECT 1 AS ok FROM community_members WHERE community_id=? AND user_id=?',[req.params.id,req.user.id]);if(!member)return res.status(403).json({error:'Únete a la comunidad para ver su contenido.'});const posts=await loadCommunityPosts(req.params.id,req.user.id);res.json({community,posts});}));
app.post('/api/communities/:id/posts', requireAuth, asyncHandler(async (req,res)=>{const member=await one('SELECT 1 AS ok FROM community_members WHERE community_id=? AND user_id=?',[req.params.id,req.user.id]);if(!member)return res.status(403).json({error:'Únete a la comunidad para publicar.'});const content=text(req.body.content,5000);if(!content)return res.status(400).json({error:'Escribe una publicación.'});const result=await run('INSERT INTO posts (community_id,user_id,content,created_at) VALUES (?,?,?,?)',[req.params.id,req.user.id,content,now()]);await addXp(req.user.id,5);res.status(201).json({post:await one('SELECT * FROM posts WHERE id=?',[result.insertId])});}));
app.post('/api/posts/:id/comments', requireAuth, asyncHandler(async (req,res)=>{const post=await one('SELECT p.* FROM posts p JOIN community_members cm ON cm.community_id=p.community_id AND cm.user_id=? WHERE p.id=?',[req.user.id,req.params.id]);if(!post)return res.status(403).json({error:'No puedes comentar aquí.'});const content=text(req.body.content,1500);if(!content)return res.status(400).json({error:'Escribe un comentario.'});const result=await run('INSERT INTO comments (post_id,user_id,content,created_at) VALUES (?,?,?,?)',[post.id,req.user.id,content,now()]);res.status(201).json({comment:await one('SELECT * FROM comments WHERE id=?',[result.insertId])});}));
app.post('/api/posts/:id/like', requireAuth, asyncHandler(async (req,res)=>{const post=await one(`SELECT p.id FROM posts p JOIN community_members cm ON cm.community_id=p.community_id AND cm.user_id=? WHERE p.id=? AND p.status='visible'`,[req.user.id,req.params.id]);if(!post)return res.status(403).json({error:'No puedes reaccionar a esta publicación.'});const existing=await one('SELECT 1 AS ok FROM post_likes WHERE post_id=? AND user_id=?',[post.id,req.user.id]);if(existing)await run('DELETE FROM post_likes WHERE post_id=? AND user_id=?',[post.id,req.user.id]);else await run('INSERT IGNORE INTO post_likes (post_id,user_id,created_at) VALUES (?,?,?)',[post.id,req.user.id,now()]);const count=await one('SELECT COUNT(*) AS total FROM post_likes WHERE post_id=?',[post.id]);res.json({liked:!existing,like_count:Number(count.total||0)});}));
app.post('/api/posts/:id/save', requireAuth, asyncHandler(async (req,res)=>{const post=await one(`SELECT p.id FROM posts p JOIN community_members cm ON cm.community_id=p.community_id AND cm.user_id=? WHERE p.id=? AND p.status='visible'`,[req.user.id,req.params.id]);if(!post)return res.status(403).json({error:'No puedes guardar esta publicación.'});const existing=await one('SELECT 1 AS ok FROM post_saves WHERE post_id=? AND user_id=?',[post.id,req.user.id]);if(existing)await run('DELETE FROM post_saves WHERE post_id=? AND user_id=?',[post.id,req.user.id]);else await run('INSERT IGNORE INTO post_saves (post_id,user_id,created_at) VALUES (?,?,?)',[post.id,req.user.id,now()]);res.json({saved:!existing});}));
app.get('/api/communities/:id/detail', requireAuth, asyncHandler(async (req,res)=>{
  const community=await one(`SELECT c.*,u.name AS owner_name,COUNT(DISTINCT cm.user_id) AS members,COUNT(DISTINCT r.id) AS rooms,COUNT(DISTINCT cr.id) AS resources FROM communities c JOIN users u ON u.id=c.owner_id LEFT JOIN community_members cm ON cm.community_id=c.id LEFT JOIN rooms r ON r.community_id=c.id AND r.status='active' LEFT JOIN community_resources cr ON cr.community_id=c.id WHERE c.id=? GROUP BY c.id`,[req.params.id]);
  if(!community)return res.status(404).json({error:'Comunidad no encontrada.'});
  const joined=await one('SELECT 1 AS ok FROM community_members WHERE community_id=? AND user_id=?',[community.id,req.user.id]);
  if(!joined)return res.status(403).json({error:'Únete a la comunidad para ver su contenido.'});
  const [posts,members,rooms,resources,projects,challenges]=await Promise.all([
    loadCommunityPosts(community.id,req.user.id),
    all(`SELECT u.id,u.name,u.university,u.career,u.xp,u.avatar_color,cm.joined_at FROM community_members cm JOIN users u ON u.id=cm.user_id WHERE cm.community_id=? ORDER BY u.xp DESC`,[community.id]),
    all(`SELECT r.*,u.name AS owner_name,COUNT(DISTINCT rm.user_id) AS members,MAX(CASE WHEN rm.user_id=? THEN 1 ELSE 0 END) AS joined FROM rooms r JOIN users u ON u.id=r.owner_id LEFT JOIN room_members rm ON rm.room_id=r.id WHERE r.community_id=? AND r.status='active' GROUP BY r.id ORDER BY members DESC`,[req.user.id,community.id]),
    all(`SELECT cr.*,u.name FROM community_resources cr JOIN users u ON u.id=cr.user_id WHERE cr.community_id=? ORDER BY cr.id DESC`,[community.id]),
    all(`SELECT cp.*,u.name FROM community_projects cp JOIN users u ON u.id=cp.user_id WHERE cp.community_id=? ORDER BY cp.id DESC`,[community.id]),
    all(`SELECT cc.*,u.name FROM community_challenges cc JOIN users u ON u.id=cc.user_id WHERE cc.community_id=? ORDER BY cc.id DESC`,[community.id])
  ]);
  res.json({community:{...community,joined:1},posts,members,rooms,resources,projects,challenges});
}));
app.post('/api/communities/:id/resources', requireAuth, asyncHandler(async (req,res)=>{const member=await one('SELECT 1 AS ok FROM community_members WHERE community_id=? AND user_id=?',[req.params.id,req.user.id]);if(!member)return res.status(403).json({error:'Únete a la comunidad.'});const title=text(req.body.title,160),url=text(req.body.url,1000);if(!title||!/^https?:\/\//i.test(url))return res.status(400).json({error:'Escribe título y URL válida.'});const type=['link','pdf','repository','video','notes'].includes(req.body.resource_type)?req.body.resource_type:'link';const result=await run('INSERT INTO community_resources (community_id,user_id,title,description,url,resource_type,created_at) VALUES (?,?,?,?,?,?,?)',[req.params.id,req.user.id,title,text(req.body.description,500),url,type,now()]);res.status(201).json({resource:await one('SELECT * FROM community_resources WHERE id=?',[result.insertId])});}));
app.post('/api/communities/:id/projects', requireAuth, asyncHandler(async (req,res)=>{const member=await one('SELECT 1 AS ok FROM community_members WHERE community_id=? AND user_id=?',[req.params.id,req.user.id]);if(!member)return res.status(403).json({error:'Únete a la comunidad.'});const title=text(req.body.title,160),projectUrl=text(req.body.project_url,1000);if(!title)return res.status(400).json({error:'Escribe el nombre del proyecto.'});if(projectUrl&&!/^https?:\/\//i.test(projectUrl))return res.status(400).json({error:'El enlace del proyecto debe comenzar con http.'});const status=['development','review','completed'].includes(req.body.status)?req.body.status:'development';const result=await run('INSERT INTO community_projects (community_id,user_id,title,description,stack,project_url,status,created_at) VALUES (?,?,?,?,?,?,?,?)',[req.params.id,req.user.id,title,text(req.body.description,1000),text(req.body.stack,255),projectUrl,status,now()]);res.status(201).json({project:await one('SELECT * FROM community_projects WHERE id=?',[result.insertId])});}));
app.post('/api/communities/:id/challenges', requireAuth, asyncHandler(async (req,res)=>{const community=await one('SELECT owner_id FROM communities WHERE id=?',[req.params.id]);if(!community||(!['admin','moderator'].includes(req.user.role)&&Number(community.owner_id)!==Number(req.user.id)))return res.status(403).json({error:'Solo responsables y moderadores pueden crear retos.'});const title=text(req.body.title,160);if(!title)return res.status(400).json({error:'Escribe el nombre del reto.'});const difficulty=['Básica','Intermedia','Avanzada'].includes(req.body.difficulty)?req.body.difficulty:'Básica';const result=await run('INSERT INTO community_challenges (community_id,user_id,title,description,difficulty,estimated_time,xp,created_at) VALUES (?,?,?,?,?,?,?,?)',[req.params.id,req.user.id,title,text(req.body.description,1000),difficulty,text(req.body.estimated_time,80)||'1 día',Math.max(10,number(req.body.xp,50)),now()]);res.status(201).json({challenge:await one('SELECT * FROM community_challenges WHERE id=?',[result.insertId])});}));

app.get('/api/ranking', requireAuth, asyncHandler(async (req,res)=>{const users=await all("SELECT id,name,university,xp,streak,avatar_color FROM users WHERE is_active=1 AND status='active' ORDER BY xp DESC,streak DESC,id LIMIT 100");const universities=await all("SELECT university,SUM(xp) AS xp,COUNT(*) AS users FROM users WHERE is_active=1 AND status='active' GROUP BY university ORDER BY xp DESC LIMIT 10");const position=users.findIndex(user=>Number(user.id)===Number(req.user.id))+1;res.json({users,universities,me:{...publicUser(req.user),position:position||users.length+1}});}));

function localAcademicAnswer(prompt,mode){const clean=text(prompt,3000);const q=clean.toLowerCase();const libraries=[{keys:['sql','mysql','base de datos'],title:'Bases de datos',body:'Una base de datos relacional organiza información en tablas relacionadas. En MySQL usa claves primarias, claves foráneas y consultas parametrizadas para mantener integridad y seguridad.'},{keys:['algoritmo','complejidad'],title:'Algoritmos',body:'La complejidad describe cómo crece el trabajo de un algoritmo. Identifica la operación dominante y elimina constantes y términos menores.'},{keys:['integral','integración'],title:'Cálculo integral',body:'Observa la forma de la integral: una composición sugiere sustitución, un producto puede requerir partes y una función racional puede usar fracciones parciales.'},{keys:['java','scanner','clase'],title:'Java',body:'Una clase define atributos y métodos; un objeto es una instancia. Después de nextInt() suele convenir consumir el salto de línea antes de usar nextLine().'},{keys:['html','css','javascript','node','express'],title:'Desarrollo web',body:'HTML estructura, CSS presenta y JavaScript agrega comportamiento. Node.js ejecuta JavaScript en el servidor y Express organiza rutas y middleware.'}];const topic=libraries.find(item=>item.keys.some(k=>q.includes(k)));const base=topic?topic.body:`Para trabajar “${clean.slice(0,120)}”, separa concepto, datos, objetivo y una prueba pequeña. Después valida el resultado con un ejemplo.`;if(mode==='quiz')return `${topic?topic.title:'Práctica'} — mini quiz\n\n1. Define el concepto principal.\n2. Da un ejemplo.\n3. Menciona un error común.\n4. Resuelve un caso pequeño.`;if(mode==='study')return `Plan de estudio local para: ${clean}\n\n1. 10 min de definiciones.\n2. 20 min con un ejemplo.\n3. 25 min resolviendo un ejercicio.\n4. 10 min para corregir errores.\n5. 5 min de resumen.`;if(mode==='debug')return `Ruta de depuración\n\n1. Reproduce el error.\n2. Lee el primer mensaje.\n3. Comprueba entradas y tipos.\n4. Agrega registros temporales.\n5. Cambia una cosa a la vez.\n\nPista: ${base}`;if(mode==='summary')return `Resumen local\n\n${base}\n\nIdea clave: aplica un procedimiento corto y valida con una prueba.`;return `${topic?topic.title:'Explicación guiada'}\n\n${base}\n\nEjercicio: crea un ejemplo mínimo, explica por qué funciona y modifica una condición.`;}
app.get('/api/ai/history', requireAuth, asyncHandler(async (req,res)=>res.json({history:await all('SELECT * FROM ai_history WHERE user_id=? ORDER BY id DESC LIMIT 20',[req.user.id])})));
app.post('/api/ai', requireAuth, asyncHandler(async (req,res)=>{const prompt=text(req.body.prompt,3000);const mode=['explain','quiz','study','debug','summary'].includes(req.body.mode)?req.body.mode:'explain';if(!prompt)return res.status(400).json({error:'Escribe una pregunta académica.'});const response=localAcademicAnswer(prompt,mode);await run('INSERT INTO ai_history (user_id,mode,prompt,response,created_at) VALUES (?,?,?,?,?)',[req.user.id,mode,prompt,response,now()]);res.json({response,local:true});}));

app.get('/api/events', requireAuth, asyncHandler(async (req,res)=>res.json({events:await all(`SELECT e.*,c.name AS community_name FROM events e LEFT JOIN communities c ON c.id=e.community_id WHERE e.user_id=? OR (e.is_official=1 AND e.status IN ('scheduled','active')) ORDER BY e.start_date,e.start_time,e.id`,[req.user.id])})));
app.post('/api/events', requireAuth, asyncHandler(async (req,res)=>{const title=text(req.body.title,160),start=text(req.body.start_date,10);if(!title||!isDateOnly(start))return res.status(400).json({error:'Escribe título y fecha válida.'});const result=await run('INSERT INTO events (user_id,community_id,title,description,type,start_date,end_date,start_time,color,is_official,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,0,\'scheduled\',?)',[req.user.id,req.body.community_id||null,title,text(req.body.description,1000),text(req.body.type,50)||'Personal',start,start,text(req.body.start_time,8)||'18:00',text(req.body.color,20)||'#5b8cff',now()]);res.status(201).json({event:await one('SELECT * FROM events WHERE id=?',[result.insertId])});}));
app.patch('/api/events/:id', requireAuth, asyncHandler(async (req,res)=>{const event=await one('SELECT * FROM events WHERE id=? AND user_id=?',[req.params.id,req.user.id]);if(!event)return res.status(404).json({error:'Evento no encontrado.'});const start=text(req.body.start_date??event.start_date,10);if(!isDateOnly(start))return res.status(400).json({error:'La fecha del evento no es válida.'});await run('UPDATE events SET title=?,description=?,type=?,start_date=?,end_date=?,start_time=?,color=? WHERE id=?',[text(req.body.title??event.title,160)||event.title,text(req.body.description??event.description,1000),text(req.body.type??event.type,50)||event.type,start,start,text(req.body.start_time??event.start_time,8)||event.start_time,text(req.body.color??event.color,20)||event.color,event.id]);res.json({event:await one('SELECT * FROM events WHERE id=?',[event.id])});}));
app.delete('/api/events/:id', requireAuth, asyncHandler(async (req,res)=>{const result=await run('DELETE FROM events WHERE id=? AND user_id=?',[req.params.id,req.user.id]);res.status(result.affectedRows?200:404).json(result.affectedRows?{ok:true}:{error:'Evento no encontrado.'});}));

app.get('/api/admin/overview', requireAdmin, asyncHandler(async (req,res)=>{
  const [users,communities,rooms,events,recentUsers,recentActivity,pendingReports,pendingCommunities,pendingRooms] = await Promise.all([
    one('SELECT COUNT(*) AS total,SUM(status=\'active\') AS active FROM users'),
    one('SELECT COUNT(*) AS total,SUM(status=\'active\') AS active FROM communities'),
    one('SELECT COUNT(*) AS total,SUM(status=\'active\') AS active FROM rooms'),
    one("SELECT COUNT(*) AS total,SUM(status IN ('scheduled','active')) AS active FROM events"),
    all('SELECT id,name,email,university,role,status,xp,created_at FROM users ORDER BY id DESC LIMIT 6'),
    all('SELECT a.*,u.name FROM admin_activity a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 8'),
    one("SELECT COUNT(*) AS total FROM moderation_reports WHERE status='pending'"),
    one("SELECT COUNT(*) AS total FROM communities WHERE status='pending'"),
    one("SELECT COUNT(*) AS total FROM rooms WHERE status='pending'")
  ]);
  const activity=[];for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const key=d.toISOString().slice(0,10);const row=await one('SELECT COUNT(DISTINCT user_id) AS total FROM admin_activity WHERE created_at LIKE ?',[`${key}%`]);activity.push({date:key,total:Number(row.total||0)});} 
  res.json({metrics:{users:Number(users.total),activeUsers:Number(users.active||0),communities:Number(communities.active||0),rooms:Number(rooms.active||0),events:Number(events.active||0)},activity,recentUsers,recentActivity,alerts:{reports:Number(pendingReports.total),communities:Number(pendingCommunities.total),rooms:Number(pendingRooms.total)}});
}));
app.get('/api/admin/stats', requireAdmin, asyncHandler(async (req,res)=>{const data=await Promise.all([one('SELECT COUNT(*) AS total,SUM(is_active) AS active FROM users'),one('SELECT COUNT(*) AS total FROM pomodoro_sessions'),one('SELECT COUNT(*) AS total FROM rooms'),one('SELECT COUNT(*) AS total FROM communities'),one('SELECT COUNT(*) AS total FROM posts'),one('SELECT COUNT(*) AS total FROM tasks')]);res.json({stats:{users:Number(data[0].total),activeUsers:Number(data[0].active||0),pomodoros:Number(data[1].total),rooms:Number(data[2].total),communities:Number(data[3].total),posts:Number(data[4].total),tasks:Number(data[5].total)}});}));

app.get('/api/admin/users', requireAdmin, asyncHandler(async (req,res)=>res.json({users:await all('SELECT id,name,email,university,career,role,status,is_active,xp,streak,created_at,last_active FROM users ORDER BY id DESC')})));
app.post('/api/admin/users', requireAdmin, asyncHandler(async (req,res)=>{const name=text(req.body.name,80),email=text(req.body.email,120).toLowerCase(),password=String(req.body.password||'Demo123!');if(!name||!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({error:'Completa nombre y correo válido.'});if(password.length<8)return res.status(400).json({error:'La contraseña temporal debe tener al menos 8 caracteres.'});try{const role=['student','moderator','admin'].includes(req.body.role)?req.body.role:'student';const status=['active','pending','suspended'].includes(req.body.status)?req.body.status:'active';const result=await run('INSERT INTO users (name,email,password_hash,university,career,role,status,is_active,xp,streak,created_at,last_active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[name,email,bcrypt.hashSync(password,10),text(req.body.university,80)||'UPSIN',text(req.body.career,120)||'Tecnologías de la Información',role,status,status==='active'?1:0,Math.max(0,number(req.body.xp,0)),1,now(),now()]);if(status==='active')await ensureStarterExperience(result.insertId);await logActivity(req.user.id,'Registró usuario','user',result.insertId,name);res.status(201).json({user:publicUser(await one('SELECT * FROM users WHERE id=?',[result.insertId]))});}catch(error){if(error.code==='ER_DUP_ENTRY')return res.status(409).json({error:'Ese correo ya existe.'});throw error;}}));
app.patch('/api/admin/users/:id', requireAdmin, asyncHandler(async (req,res)=>{const user=await one('SELECT * FROM users WHERE id=?',[req.params.id]);if(!user)return res.status(404).json({error:'Usuario no encontrado.'});const role=['student','moderator','admin'].includes(req.body.role)?req.body.role:user.role;const status=['active','pending','suspended'].includes(req.body.status)?req.body.status:(req.body.is_active===undefined?user.status:(bool(req.body.is_active)?'active':'suspended'));if(Number(user.id)===Number(req.user.id)&&status==='suspended')return res.status(400).json({error:'No puedes suspender tu propia cuenta.'});await run('UPDATE users SET name=?,email=?,university=?,career=?,role=?,status=?,is_active=?,xp=? WHERE id=?',[text(req.body.name??user.name,80)||user.name,text(req.body.email??user.email,120).toLowerCase()||user.email,text(req.body.university??user.university,80),text(req.body.career??user.career,120),role,status,status==='active'?1:0,Math.max(0,number(req.body.xp,user.xp)),user.id]);await logActivity(req.user.id,'Actualizó usuario','user',user.id,user.name);res.json({user:publicUser(await one('SELECT * FROM users WHERE id=?',[user.id]))});}));
app.delete('/api/admin/users/:id', requireAdmin, asyncHandler(async (req,res)=>{const id=Number(req.params.id);if(id===Number(req.user.id))return res.status(400).json({error:'No puedes eliminar tu propia cuenta.'});const user=await one('SELECT name FROM users WHERE id=?',[id]);const result=await run('DELETE FROM users WHERE id=?',[id]);if(result.affectedRows)await logActivity(req.user.id,'Eliminó usuario','user',id,user?.name||'');res.status(result.affectedRows?200:404).json(result.affectedRows?{ok:true}:{error:'Usuario no encontrado.'});}));

app.get('/api/admin/communities', requireAdmin, asyncHandler(async (req,res)=>res.json({communities:await all(`SELECT c.*,u.name AS owner_name,COUNT(DISTINCT cm.user_id) AS members,COUNT(DISTINCT r.id) AS rooms FROM communities c JOIN users u ON u.id=c.owner_id LEFT JOIN community_members cm ON cm.community_id=c.id LEFT JOIN rooms r ON r.community_id=c.id GROUP BY c.id ORDER BY c.id DESC`)})));
app.post('/api/admin/communities', requireAdmin, asyncHandler(async (req,res)=>{const name=text(req.body.name,120);if(!name)return res.status(400).json({error:'Escribe el nombre.'});const result=await run('INSERT INTO communities (owner_id,name,description,category,university,is_private,status,created_at) VALUES (?,?,?,?,?,?,?,?)',[req.user.id,name,text(req.body.description,1200),text(req.body.category,80)||'Tecnología',text(req.body.university,80)||'General',bool(req.body.is_private)?1:0,['active','pending','suspended'].includes(req.body.status)?req.body.status:'active',now()]);await run('INSERT IGNORE INTO community_members (community_id,user_id,joined_at) VALUES (?,?,?)',[result.insertId,req.user.id,now()]);await ensureCommunityStarterContent(result.insertId,req.user.id);await logActivity(req.user.id,'Creó comunidad','community',result.insertId,name);res.status(201).json({community:await one('SELECT * FROM communities WHERE id=?',[result.insertId])});}));
app.patch('/api/admin/communities/:id', requireAdmin, asyncHandler(async (req,res)=>{const item=await one('SELECT * FROM communities WHERE id=?',[req.params.id]);if(!item)return res.status(404).json({error:'Comunidad no encontrada.'});const status=['active','pending','suspended'].includes(req.body.status)?req.body.status:item.status;await run('UPDATE communities SET name=?,description=?,category=?,university=?,is_private=?,status=? WHERE id=?',[text(req.body.name??item.name,120)||item.name,text(req.body.description??item.description,1200),text(req.body.category??item.category,80)||item.category,text(req.body.university??item.university,80)||item.university,req.body.is_private===undefined?item.is_private:(bool(req.body.is_private)?1:0),status,item.id]);await logActivity(req.user.id,'Actualizó comunidad','community',item.id,item.name);res.json({community:await one('SELECT * FROM communities WHERE id=?',[item.id])});}));
app.delete('/api/admin/communities/:id', requireAdmin, asyncHandler(async (req,res)=>{const item=await one('SELECT name FROM communities WHERE id=?',[req.params.id]);const result=await run('DELETE FROM communities WHERE id=?',[req.params.id]);if(result.affectedRows)await logActivity(req.user.id,'Eliminó comunidad','community',req.params.id,item?.name||'');res.status(result.affectedRows?200:404).json(result.affectedRows?{ok:true}:{error:'Comunidad no encontrada.'});}));

app.get('/api/admin/rooms', requireAdmin, asyncHandler(async (req,res)=>res.json({rooms:await all(`SELECT r.*,c.name AS community_name,u.name AS owner_name,COUNT(DISTINCT rm.user_id) AS active_users FROM rooms r JOIN users u ON u.id=r.owner_id LEFT JOIN communities c ON c.id=r.community_id LEFT JOIN room_members rm ON rm.room_id=r.id GROUP BY r.id ORDER BY r.id DESC`)})));
app.post('/api/admin/rooms', requireAdmin, asyncHandler(async (req,res)=>{const name=text(req.body.name,120);if(!name)return res.status(400).json({error:'Escribe el nombre.'});const result=await run('INSERT INTO rooms (owner_id,community_id,name,topic,description,category,capacity,is_private,access_code,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[req.user.id,req.body.community_id||null,name,text(req.body.topic,80)||'General',text(req.body.description,1200),text(req.body.category,80)||'General',Math.max(2,number(req.body.capacity,30)),bool(req.body.is_private)?1:0,text(req.body.access_code,80),['active','pending','closed'].includes(req.body.status)?req.body.status:'active',now()]);await logActivity(req.user.id,'Creó sala','room',result.insertId,name);res.status(201).json({room:await one('SELECT * FROM rooms WHERE id=?',[result.insertId])});}));
app.patch('/api/admin/rooms/:id', requireAdmin, asyncHandler(async (req,res)=>{const item=await one('SELECT * FROM rooms WHERE id=?',[req.params.id]);if(!item)return res.status(404).json({error:'Sala no encontrada.'});const status=['active','pending','closed'].includes(req.body.status)?req.body.status:item.status;await run('UPDATE rooms SET community_id=?,name=?,topic=?,description=?,category=?,capacity=?,is_private=?,access_code=?,status=? WHERE id=?',[req.body.community_id===undefined?item.community_id:(req.body.community_id||null),text(req.body.name??item.name,120)||item.name,text(req.body.topic??item.topic,80)||item.topic,text(req.body.description??item.description,1200),text(req.body.category??item.category,80)||item.category,Math.max(2,number(req.body.capacity,item.capacity)),req.body.is_private===undefined?item.is_private:(bool(req.body.is_private)?1:0),text(req.body.access_code??item.access_code,80),status,item.id]);await logActivity(req.user.id,'Actualizó sala','room',item.id,item.name);res.json({room:await one('SELECT * FROM rooms WHERE id=?',[item.id])});}));
app.delete('/api/admin/rooms/:id', requireAdmin, asyncHandler(async (req,res)=>{const item=await one('SELECT name FROM rooms WHERE id=?',[req.params.id]);const result=await run('DELETE FROM rooms WHERE id=?',[req.params.id]);if(result.affectedRows)await logActivity(req.user.id,'Eliminó sala','room',req.params.id,item?.name||'');res.status(result.affectedRows?200:404).json(result.affectedRows?{ok:true}:{error:'Sala no encontrada.'});}));

app.get('/api/admin/events', requireAdmin, asyncHandler(async (req,res)=>res.json({events:await all(`SELECT e.*,c.name AS community_name,u.name AS creator_name FROM events e JOIN users u ON u.id=e.user_id LEFT JOIN communities c ON c.id=e.community_id ORDER BY e.start_date,e.start_time,e.id DESC`)})));
app.post('/api/admin/events', requireAdmin, asyncHandler(async (req,res)=>{const title=text(req.body.title,160),start=text(req.body.start_date,10);if(!title||!isDateOnly(start))return res.status(400).json({error:'Completa título y fecha.'});const result=await run('INSERT INTO events (user_id,community_id,title,description,type,start_date,end_date,start_time,color,is_official,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[req.user.id,req.body.community_id||null,title,text(req.body.description,1000),text(req.body.type,50)||'Evento oficial',start,start,text(req.body.start_time,8)||'18:00',text(req.body.color,20)||'#4b8cff',bool(req.body.is_official)?1:0,['pending','scheduled','active','rejected','completed'].includes(req.body.status)?req.body.status:'scheduled',now()]);await logActivity(req.user.id,'Creó evento','event',result.insertId,title);res.status(201).json({event:await one('SELECT * FROM events WHERE id=?',[result.insertId])});}));
app.patch('/api/admin/events/:id', requireAdmin, asyncHandler(async (req,res)=>{const item=await one('SELECT * FROM events WHERE id=?',[req.params.id]);if(!item)return res.status(404).json({error:'Evento no encontrado.'});const status=['pending','scheduled','active','rejected','completed'].includes(req.body.status)?req.body.status:item.status;const start=text(req.body.start_date??item.start_date,10);if(!isDateOnly(start))return res.status(400).json({error:'La fecha del evento no es válida.'});await run('UPDATE events SET community_id=?,title=?,description=?,type=?,start_date=?,end_date=?,start_time=?,color=?,is_official=?,status=? WHERE id=?',[req.body.community_id===undefined?item.community_id:(req.body.community_id||null),text(req.body.title??item.title,160)||item.title,text(req.body.description??item.description,1000),text(req.body.type??item.type,50)||item.type,start,start,text(req.body.start_time??item.start_time,8)||item.start_time,text(req.body.color??item.color,20)||item.color,req.body.is_official===undefined?item.is_official:(bool(req.body.is_official)?1:0),status,item.id]);await logActivity(req.user.id,'Actualizó evento','event',item.id,item.title);res.json({event:await one('SELECT * FROM events WHERE id=?',[item.id])});}));
app.post('/api/admin/events/:id/review', requireAdmin, asyncHandler(async (req,res)=>{const action=req.body.action==='approve'?'scheduled':'rejected';const result=await run('UPDATE events SET status=?,is_official=? WHERE id=? AND status=\'pending\'',[action,action==='scheduled'?1:0,req.params.id]);if(!result.affectedRows)return res.status(404).json({error:'Solicitud no encontrada o ya revisada.'});await logActivity(req.user.id,action==='scheduled'?'Aprobó evento':'Rechazó evento','event',req.params.id,'Solicitud comunitaria');res.json({ok:true,status:action});}));
app.delete('/api/admin/events/:id', requireAdmin, asyncHandler(async (req,res)=>{const result=await run('DELETE FROM events WHERE id=?',[req.params.id]);res.status(result.affectedRows?200:404).json(result.affectedRows?{ok:true}:{error:'Evento no encontrado.'});}));

app.get('/api/admin/reports', requireAdmin, asyncHandler(async (req,res)=>{
  const [activeUsers,pomodoros,activeRooms,topCommunity,topCategories,topUsers,communityParticipation] = await Promise.all([
    one("SELECT COUNT(*) AS total FROM users WHERE status='active' AND is_active=1"),
    one('SELECT COUNT(*) AS total FROM pomodoro_sessions'),
    one("SELECT COUNT(*) AS total FROM rooms WHERE status='active'"),
    one(`SELECT c.id,c.name,COUNT(cm.user_id) AS members FROM communities c LEFT JOIN community_members cm ON cm.community_id=c.id GROUP BY c.id ORDER BY members DESC LIMIT 1`),
    all(`SELECT category,COUNT(*) AS total FROM communities GROUP BY category ORDER BY total DESC LIMIT 5`),
    all("SELECT id,name,xp FROM users WHERE status='active' ORDER BY xp DESC LIMIT 5"),
    all(`SELECT c.name,COUNT(cm.user_id) AS total FROM communities c LEFT JOIN community_members cm ON cm.community_id=c.id GROUP BY c.id ORDER BY total DESC LIMIT 5`)
  ]);
  const usersSeries=[];for(let i=5;i>=0;i--){const d=new Date();d.setMonth(d.getMonth()-i);const prefix=d.toISOString().slice(0,7);const row=await one('SELECT COUNT(*) AS total FROM users WHERE created_at LIKE ?',[`${prefix}%`]);usersSeries.push({label:d.toLocaleDateString('es-MX',{month:'short'}),total:Number(row.total||0)});} 
  res.json({summary:{activeUsers:Number(activeUsers.total),pomodoros:Number(pomodoros.total),activeRooms:Number(activeRooms.total),topCommunity:topCommunity?.name||'Sin datos'},usersSeries,communityParticipation,topCategories,topUsers});
}));
app.get('/api/admin/reports/export', requireAdmin, asyncHandler(async (req,res)=>{const rows=await all('SELECT id,name,email,university,role,status,xp,created_at FROM users ORDER BY id');const header='id,nombre,correo,universidad,rol,estado,xp,creado\n';const csv=header+rows.map(r=>[r.id,r.name,r.email,r.university,r.role,r.status,r.xp,r.created_at].map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="focurion-reporte-usuarios.csv"');res.send('\ufeff'+csv);}));

app.get('/api/admin/moderation', requireAdmin, asyncHandler(async (req,res)=>res.json({reports:await all(`SELECT mr.*,u.name AS reporter_name,r.name AS resolver_name FROM moderation_reports mr LEFT JOIN users u ON u.id=mr.reporter_id LEFT JOIN users r ON r.id=mr.resolved_by ORDER BY mr.status='pending' DESC,mr.id DESC`)})));
app.patch('/api/admin/moderation/:id', requireAdmin, asyncHandler(async (req,res)=>{const status=req.body.action==='resolve'?'resolved':'dismissed';const item=await one('SELECT * FROM moderation_reports WHERE id=?',[req.params.id]);if(!item)return res.status(404).json({error:'Incidencia no encontrada.'});await run('UPDATE moderation_reports SET status=?,resolved_at=?,resolved_by=? WHERE id=?',[status,now(),req.user.id,item.id]);if(status==='resolved'&&req.body.suspend&&item.entity_type==='user')await run("UPDATE users SET status='suspended',is_active=0 WHERE id=?",[item.entity_id]);if(status==='resolved'&&req.body.hide&&item.entity_type==='post')await run("UPDATE posts SET status='hidden' WHERE id=?",[item.entity_id]);await logActivity(req.user.id,status==='resolved'?'Resolvió incidencia':'Descartó incidencia','moderation',item.id,item.entity_name);res.json({ok:true,status});}));

app.get('/api/admin/backup', requireAdmin, asyncHandler(async (req,res)=>{
  if(req.user.role!=='admin')return res.status(403).json({error:'Solo un administrador puede descargar respaldos.'});
  await logActivity(req.user.id,'Descargó respaldo','system',null,'Exportación JSON de los datos de Focurion.');
  const tables = [
    'communities','community_members','rooms','room_members','room_messages','room_objectives','room_resources',
    'tasks','goals','notes','pomodoro_sessions','posts','comments','post_likes','post_saves','community_resources','community_projects',
    'community_challenges','events','ai_history','moderation_reports','admin_activity','system_settings'
  ];
  const data = {
    users: await all(`SELECT id,name,email,university,career,role,status,is_active,xp,streak,avatar_color,theme,language,timezone,
      pomodoro_minutes,short_break_minutes,long_break_minutes,weekly_goal_hours,notifications,created_at,last_active FROM users ORDER BY id`)
  };
  for(const table of tables)data[table]=await all(`SELECT * FROM \`${table}\` ORDER BY 1`);
  const generatedAt=now();
  const filename=`focurion-respaldo-${generatedAt.slice(0,19).replace(/[:T]/g,'-')}.json`;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
  res.send(JSON.stringify({
    metadata:{app:'Focurion',version:'2.1.1',generated_at:generatedAt,database:DB_NAME,mysql_port:activeDbPort,contains_passwords:false},
    data
  },null,2));
}));

app.get('/api/admin/settings', requireAdmin, asyncHandler(async (req,res)=>{const rows=await all('SELECT setting_key,setting_value FROM system_settings');res.json({settings:Object.fromEntries(rows.map(r=>[r.setting_key,r.setting_value])),profile:publicUser(req.user)});}));
app.patch('/api/admin/settings', requireAdmin, asyncHandler(async (req,res)=>{const values=req.body.settings||{};for(const [key,value] of Object.entries(values)){if(!['admin_theme','report_notifications','room_alerts','allow_registration','community_auto_approval'].includes(key))continue;await run('INSERT INTO system_settings (setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',[key,String(value)]);}await logActivity(req.user.id,'Actualizó configuración','system',null,'Preferencias administrativas');res.json({ok:true});}));

app.get('/app',(req,res)=>res.sendFile(path.join(__dirname,'public','app.html')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

io.engine.use(sessionMiddleware);
io.use(async (socket,next)=>{try{const id=socket.request.session?.userId;if(!id)return next(new Error('No autenticado'));const user=await one("SELECT * FROM users WHERE id=? AND is_active=1 AND status<>'suspended'",[id]);if(!user)return next(new Error('No autenticado'));socket.user=user;next();}catch(error){next(error);}});
io.on('connection',socket=>{
  socket.join(`user:${socket.user.id}`);
  if (['admin','moderator'].includes(socket.user.role)) socket.join('role:admin');
  socket.on('room:join',async roomId=>{const member=await one('SELECT 1 AS ok FROM room_members WHERE room_id=? AND user_id=?',[Number(roomId),socket.user.id]);if(member)socket.join(`room:${Number(roomId)}`);});
  socket.on('room:message',async payload=>{try{const roomId=Number(payload?.roomId);const content=text(payload?.content,1000);if(!content)return;const member=await one('SELECT 1 AS ok FROM room_members WHERE room_id=? AND user_id=?',[roomId,socket.user.id]);if(!member)return;const stamp=now();const result=await run('INSERT INTO room_messages (room_id,user_id,content,created_at) VALUES (?,?,?,?)',[roomId,socket.user.id,content,stamp]);io.to(`room:${roomId}`).emit('room:message',{id:result.insertId,room_id:roomId,user_id:socket.user.id,content,created_at:stamp,name:socket.user.name,avatar_color:socket.user.avatar_color});}catch(error){console.error('Socket message error:',error.message);}});
});

app.use((error,req,res,next)=>{
  console.error(error);
  if(res.headersSent)return next(error);
  if(error.code==='ECONNREFUSED')return res.status(503).json({error:'No se pudo conectar con MySQL. Revisa que XAMPP tenga MySQL iniciado.'});
  res.status(500).json({error:'Ocurrió un error en el servidor.'});
});

async function startServer(){
  try{
    await createDatabase();
    await createSchema();
    await seedDb();
    // Garantiza que la cuenta de demostración administrativa conserve su rol,
    // incluso si la base ya existía de una ejecución anterior.
    await run("UPDATE users SET role='admin', status='active', is_active=1 WHERE email='admin@focurion.local'");
    await ensureStarterContentForExistingData();
    await refreshDemoDates();
    server.listen(PORT,()=>{
      console.log(`\nFocurion disponible en puerto ${PORT}`);
      console.log(`MySQL: ${DB_CONFIG.host}:${activeDbPort}/${DB_NAME}`);
      console.log('Cuenta demo: alumno@focurion.local / Demo123!');
      console.log('Administrador: admin@focurion.local / Admin123!\n');
    });
  }catch(error){
    console.error('\nNo fue posible iniciar Focurion con MySQL.');
    console.error(IS_LOCAL_DB ? 'Revisa que MySQL esté iniciado en XAMPP y que .env coincida con tu configuración.' : 'Revisa las variables DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME y DB_SSL del hosting.');
    console.error(`Host: ${DB_CONFIG.host} | Puertos probados: ${DB_PORT_CANDIDATES.join(', ')} | Usuario: ${DB_CONFIG.user} | Base: ${DB_NAME}`);
    console.error(error.message);
    process.exit(1);
  }
}

startServer();
