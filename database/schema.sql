-- Focurion MySQL / XAMPP

CREATE DATABASE IF NOT EXISTS focurion CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE focurion;

SET NAMES utf8mb4;

SET FOREIGN_KEY_CHECKS=0;

CREATE TABLE IF NOT EXISTS users (
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
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS communities (
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
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS community_members (
      community_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      joined_at VARCHAR(30) NOT NULL,
      PRIMARY KEY(community_id,user_id),
      CONSTRAINT fk_cm_community FOREIGN KEY(community_id) REFERENCES communities(id) ON DELETE CASCADE,
      CONSTRAINT fk_cm_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rooms (
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
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS room_members (
      room_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      joined_at VARCHAR(30) NOT NULL,
      PRIMARY KEY(room_id,user_id),
      CONSTRAINT fk_rm_room FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      CONSTRAINT fk_rm_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS room_messages (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      room_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      content TEXT NOT NULL,
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_messages_room FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      CONSTRAINT fk_messages_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS room_objectives (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      room_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      content VARCHAR(240) NOT NULL,
      completed TINYINT(1) NOT NULL DEFAULT 0,
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_objectives_room FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      CONSTRAINT fk_objectives_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS room_resources (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      room_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      title VARCHAR(160) NOT NULL,
      url VARCHAR(1000) NOT NULL,
      resource_type ENUM('link','document','repository','video') DEFAULT 'link',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_room_resources_room FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      CONSTRAINT fk_room_resources_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tasks (
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
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS goals (
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
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notes (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      title VARCHAR(160) NOT NULL,
      content MEDIUMTEXT,
      created_at VARCHAR(30) NOT NULL,
      updated_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_notes_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pomodoro_sessions (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      task_id INT UNSIGNED NULL,
      duration_minutes SMALLINT UNSIGNED NOT NULL,
      completed TINYINT(1) NOT NULL DEFAULT 1,
      started_at VARCHAR(30) NOT NULL,
      ended_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_pomo_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_pomo_task FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS posts (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      community_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      content TEXT NOT NULL,
      status ENUM('visible','hidden') DEFAULT 'visible',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_posts_community FOREIGN KEY(community_id) REFERENCES communities(id) ON DELETE CASCADE,
      CONSTRAINT fk_posts_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS comments (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      post_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      content TEXT NOT NULL,
      status ENUM('visible','hidden') DEFAULT 'visible',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_comments_post FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
      CONSTRAINT fk_comments_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS post_likes (
      post_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      created_at VARCHAR(30) NOT NULL,
      PRIMARY KEY(post_id,user_id),
      CONSTRAINT fk_post_likes_post FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
      CONSTRAINT fk_post_likes_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS post_saves (
      post_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      created_at VARCHAR(30) NOT NULL,
      PRIMARY KEY(post_id,user_id),
      CONSTRAINT fk_post_saves_post FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
      CONSTRAINT fk_post_saves_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS community_resources (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS community_projects (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS community_challenges (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS password_reset_codes (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      code_hash VARCHAR(255) NOT NULL,
      expires_at VARCHAR(30) NOT NULL,
      used_at VARCHAR(30) NULL,
      created_at VARCHAR(30) NOT NULL,
      INDEX idx_reset_user(user_id),
      CONSTRAINT fk_reset_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS events (
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
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ai_history (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      mode VARCHAR(30) DEFAULT 'explain',
      prompt TEXT NOT NULL,
      response MEDIUMTEXT NOT NULL,
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_ai_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS moderation_reports (
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
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS admin_activity (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NULL,
      action VARCHAR(120) NOT NULL,
      entity_type VARCHAR(50) NULL,
      entity_id INT UNSIGNED NULL,
      detail VARCHAR(500) DEFAULT '',
      created_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_activity_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS system_settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB;

SET FOREIGN_KEY_CHECKS=1;
