-- Create Database
CREATE DATABASE IF NOT EXISTS cafe_azzura CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE cafe_azzura;

-- Users Table (Admin & Kasir)
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role ENUM('admin', 'kasir', 'waiter', 'member', 'station', 'kitchen') DEFAULT 'kasir',
    avatar VARCHAR(255),
    phone VARCHAR(50),
    status ENUM('active', 'inactive') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_email (email),
    INDEX idx_role (role)
) ENGINE=InnoDB;

-- System Settings Table (Dynamic Settings)
CREATE TABLE system_settings (
    id INT PRIMARY KEY AUTO_INCREMENT,
    setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value TEXT,
    setting_type ENUM('text', 'number', 'boolean', 'json', 'image', 'color') DEFAULT 'text',
    setting_group VARCHAR(50) DEFAULT 'general',
    label VARCHAR(255),
    description TEXT,
    display_order INT DEFAULT 0,
    is_public BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_key (setting_key),
    INDEX idx_group (setting_group)
) ENGINE=InnoDB;

-- Categories Table
CREATE TABLE categories (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    image VARCHAR(255),
    icon VARCHAR(50),
    parent_id INT,
    display_order INT DEFAULT 0,
    status ENUM('active', 'inactive') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL,
    INDEX idx_slug (slug),
    INDEX idx_parent (parent_id)
) ENGINE=InnoDB;

-- Product Custom Field Definitions
CREATE TABLE product_field_definitions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    field_name VARCHAR(100) NOT NULL,
    field_label VARCHAR(255) NOT NULL,
    field_type ENUM('text', 'textarea', 'number', 'select', 'checkbox', 'date', 'image', 'color') NOT NULL,
    field_options JSON,
    is_required BOOLEAN DEFAULT FALSE,
    display_order INT DEFAULT 0,
    status ENUM('active', 'inactive') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_name (field_name)
) ENGINE=InnoDB;

-- Products Table (Flexible)
CREATE TABLE products (
    id INT PRIMARY KEY AUTO_INCREMENT,
    category_id INT,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    cost_price DECIMAL(10, 2),
    sku VARCHAR(100) UNIQUE,
    barcode VARCHAR(100),
    stock INT DEFAULT 0,
    min_stock INT DEFAULT 0,
    unit VARCHAR(50) DEFAULT 'pcs',
    image VARCHAR(255),
    gallery JSON,
    is_popular BOOLEAN DEFAULT FALSE,
    is_available BOOLEAN DEFAULT TRUE,
    status ENUM('active', 'inactive', 'draft') DEFAULT 'active',
    meta_data JSON,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_slug (slug),
    INDEX idx_category (category_id),
    INDEX idx_status (status)
) ENGINE=InnoDB;

-- Product Custom Field Values
CREATE TABLE product_custom_fields (
    id INT PRIMARY KEY AUTO_INCREMENT,
    product_id INT NOT NULL,
    field_id INT NOT NULL,
    field_value TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (field_id) REFERENCES product_field_definitions(id) ON DELETE CASCADE,
    UNIQUE KEY unique_product_field (product_id, field_id)
) ENGINE=InnoDB;

-- Orders Table
CREATE TABLE orders (
    id INT PRIMARY KEY AUTO_INCREMENT,
    order_number VARCHAR(50) UNIQUE NOT NULL,
    customer_name VARCHAR(255),
    customer_email VARCHAR(255),
    customer_phone VARCHAR(50),
    table_number VARCHAR(20),
    table_id INT,
    order_type ENUM('dine-in', 'takeaway', 'delivery') DEFAULT 'dine-in',
    subtotal DECIMAL(10, 2) NOT NULL,
    tax DECIMAL(10, 2) DEFAULT 0,
    discount DECIMAL(10, 2) DEFAULT 0,
    total DECIMAL(10, 2) NOT NULL,
    payment_method ENUM('cash', 'card', 'qris', 'transfer', 'balance') DEFAULT 'cash',
    payment_status ENUM('pending', 'paid', 'partial', 'refund') DEFAULT 'pending',
    order_status ENUM('pending', 'preparing', 'ready', 'completed', 'cancelled') DEFAULT 'pending',
    notes TEXT,
    meta_data JSON,
    served_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (served_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_order_number (order_number),
    INDEX idx_status (order_status),
    INDEX idx_created (created_at)
) ENGINE=InnoDB;

-- Order Items Table
CREATE TABLE order_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    order_id INT NOT NULL,
    product_id INT,
    product_name VARCHAR(255) NOT NULL,
    product_price DECIMAL(10, 2) NOT NULL,
    quantity INT NOT NULL,
    subtotal DECIMAL(10, 2) NOT NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Bookings Table
CREATE TABLE bookings (
    id INT PRIMARY KEY AUTO_INCREMENT,
    booking_number VARCHAR(50) UNIQUE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    booking_date DATE NOT NULL,
    booking_time TIME NOT NULL,
    guests INT NOT NULL,
    table_number VARCHAR(20),
    special_request TEXT,
    status ENUM('pending', 'confirmed', 'cancelled', 'completed') DEFAULT 'pending',
    user_id INT,
    dp_amount DECIMAL(10, 2) DEFAULT 0,
    payment_status ENUM('unpaid', 'partial', 'paid', 'refunded') DEFAULT 'unpaid',
    total_amount DECIMAL(10, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_date (booking_date),
    INDEX idx_status (status),
    INDEX idx_booking_number (booking_number)
) ENGINE=InnoDB;

-- Media/Files Table
CREATE TABLE media (
    id INT PRIMARY KEY AUTO_INCREMENT,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    file_type VARCHAR(50),
    file_size INT,
    mime_type VARCHAR(100),
    storage_type ENUM('local', 's3') DEFAULT 'local',
    s3_key VARCHAR(500),
    uploaded_by INT,
    alt_text VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_type (file_type)
) ENGINE=InnoDB;

-- Activity Logs
CREATE TABLE activity_logs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT,
    action VARCHAR(100) NOT NULL,
    table_name VARCHAR(100),
    record_id INT,
    old_values JSON,
    new_values JSON,
    severity VARCHAR(20) DEFAULT 'info',
    module VARCHAR(50),
    description TEXT,
    ip_address VARCHAR(50),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_user (user_id),
    INDEX idx_action (action),
    INDEX idx_created (created_at)
) ENGINE=InnoDB;

-- Insert Default System Settings
INSERT INTO system_settings (setting_key, setting_value, setting_type, setting_group, label, description, display_order) VALUES
('site_name', 'Café Azzura', 'text', 'general', 'Site Name', 'Name of your cafe', 1),
('site_tagline', 'Where Every Sip Tells a Story', 'text', 'general', 'Tagline', 'Site tagline or slogan', 2),
('site_logo', '', 'image', 'general', 'Logo', 'Main logo', 3),
('site_favicon', '', 'image', 'general', 'Favicon', 'Browser icon', 4),
('primary_color', '#6F4E37', 'color', 'appearance', 'Primary Color', 'Main brand color', 5),
('secondary_color', '#D4A574', 'color', 'appearance', 'Secondary Color', 'Accent color', 6),
('currency_symbol', '$', 'text', 'general', 'Currency Symbol', 'Currency symbol', 7),
('tax_rate', '10', 'number', 'general', 'Tax Rate (%)', 'Tax percentage', 8),
('contact_email', 'info@cafeazzura.com', 'text', 'contact', 'Email', 'Contact email', 9),
('contact_phone', '+1 (555) 123-4567', 'text', 'contact', 'Phone', 'Contact phone', 10),
('contact_address', '123 Coffee Street, Brew City', 'text', 'contact', 'Address', 'Physical address', 11),
('opening_hours', '{"mon-fri": "7:00 AM - 10:00 PM", "sat-sun": "8:00 AM - 11:00 PM"}', 'json', 'general', 'Opening Hours', 'Business hours', 12),
('enable_booking', 'true', 'boolean', 'features', 'Enable Booking', 'Allow table reservations', 13),
('enable_takeaway', 'true', 'boolean', 'features', 'Enable Takeaway', 'Allow takeaway orders', 14),
('enable_delivery', 'true', 'boolean', 'features', 'Enable Delivery', 'Allow delivery orders', 15),
('instagram_url', '', 'text', 'social', 'Instagram', 'Instagram URL', 16),
('facebook_url', '', 'text', 'social', 'Facebook', 'Facebook URL', 17),
('twitter_url', '', 'text', 'social', 'Twitter', 'Twitter URL', 18);

-- Insert Default Categories
INSERT INTO categories (name, slug, description, icon, display_order) VALUES
('Hot Beverages', 'hot-beverages', 'Hot coffee and tea drinks', 'coffee', 1),
('Cold Beverages', 'cold-beverages', 'Iced coffee and cold drinks', 'ice-cream', 2),
('Pastries', 'pastries', 'Fresh baked goods', 'croissant', 3),
('Specialty', 'specialty', 'Signature drinks', 'wine', 4);

-- Insert Default Admin User (password: admin123)
INSERT INTO users (name, email, password, role, status) VALUES
('Admin', 'admin@cafeazzura.com', '$2a$10$vI8aWBnW3fID.ZQ4/zo1G.q1lRps.9cGLcZEiGDMVr5yUP1KUOYTa', 'admin', 'active');

-- Insert Sample Products
INSERT INTO products (category_id, name, slug, description, price, cost_price, sku, stock, is_popular, is_available) VALUES
(1, 'Espresso', 'espresso', 'Rich and bold Italian espresso', 3.50, 1.20, 'BEV-001', 100, true, true),
(1, 'Cappuccino', 'cappuccino', 'Creamy perfection with foam art', 4.50, 1.80, 'BEV-002', 100, true, true),
(1, 'Latte', 'latte', 'Smooth and milky coffee blend', 4.75, 2.00, 'BEV-003', 100, false, true),
(2, 'Iced Americano', 'iced-americano', 'Bold and refreshing', 4.00, 1.50, 'BEV-004', 100, false, true),
(2, 'Iced Latte', 'iced-latte', 'Smooth and chilled', 5.00, 2.20, 'BEV-005', 100, true, true),
(3, 'Croissant', 'croissant', 'Buttery and flaky', 3.50, 1.50, 'PAST-001', 50, true, true),
(3, 'Chocolate Muffin', 'chocolate-muffin', 'Rich and moist', 4.00, 1.80, 'PAST-002', 50, false, true),
(4, 'Affogato', 'affogato', 'Espresso meets gelato', 6.50, 3.00, 'SPEC-001', 30, true, true);

-- Insert Sample Custom Field Definitions
INSERT INTO product_field_definitions (field_name, field_label, field_type, field_options, is_required, display_order) VALUES
('caffeine_level', 'Caffeine Level', 'select', '["Low", "Medium", "High"]', false, 1),
('temperature', 'Serving Temperature', 'select', '["Hot", "Cold", "Room"]', false, 2),
('allergens', 'Allergens', 'textarea', null, false, 3),
('origin', 'Coffee Origin', 'text', null, false, 4),
('roast_level', 'Roast Level', 'select', '["Light", "Medium", "Dark"]', false, 5);

-- ============================================================
-- External Integrations (PNP Plugin System)
-- ============================================================

-- Registry of external integrations
CREATE TABLE external_integrations (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    provider VARCHAR(50) NOT NULL COMMENT 'mikrotik_radius, custom, etc',
    config JSON COMMENT 'Provider-specific configuration',
    status ENUM('active', 'inactive') DEFAULT 'inactive',
    trigger_events JSON COMMENT 'Events to listen to: ["booking.confirmed","order.completed","order.paid"]',
    run_order INT DEFAULT 0,
    last_run_at TIMESTAMP NULL,
    last_run_status ENUM('success', 'failed') NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_slug (slug),
    INDEX idx_provider (provider),
    INDEX idx_status (status)
) ENGINE=InnoDB;

-- Audit trail for integration executions
CREATE TABLE integration_logs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    integration_id INT,
    trigger_event VARCHAR(100),
    reference_type VARCHAR(50) COMMENT 'booking, order, user',
    reference_id INT,
    request_data JSON,
    response_data JSON,
    status ENUM('success', 'failed') NOT NULL,
    error_message TEXT,
    duration_ms INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (integration_id) REFERENCES external_integrations(id) ON DELETE SET NULL,
    INDEX idx_integration (integration_id),
    INDEX idx_reference (reference_type, reference_id),
    INDEX idx_created (created_at)
) ENGINE=InnoDB;

-- Generated WiFi credentials linked to bookings/orders
CREATE TABLE wifi_credentials (
    id INT PRIMARY KEY AUTO_INCREMENT,
    booking_id INT,
    order_id INT,
    integration_id INT,
    username VARCHAR(100) NOT NULL,
    password VARCHAR(100) NOT NULL,
    ssid VARCHAR(255),
    valid_from DATETIME NOT NULL,
    valid_until DATETIME NOT NULL,
    status ENUM('active', 'expired', 'revoked') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
    FOREIGN KEY (integration_id) REFERENCES external_integrations(id) ON DELETE SET NULL,
    INDEX idx_booking (booking_id),
    INDEX idx_order (order_id),
    INDEX idx_username (username),
    INDEX idx_status (status)
) ENGINE=InnoDB;

-- Integration settings
INSERT INTO system_settings (setting_key, setting_value, setting_type, setting_group, label, description, display_order) VALUES
('wifi_ssid', 'Cafe-Azzura-WiFi', 'text', 'integrations', 'WiFi SSID', 'Nama jaringan WiFi untuk kredensial', 50),
('wifi_credential_duration_hours', '4', 'number', 'integrations', 'Masa Berlaku WiFi (Jam)', 'Durasi kredensial WiFi aktif sejak dibuat', 51),
('wifi_password_length', '8', 'number', 'integrations', 'Panjang Password WiFi', 'Jumlah karakter password WiFi yang digenerate', 52);
