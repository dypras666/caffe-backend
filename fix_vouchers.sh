#!/bin/bash
for dir in /opt/cafe-azzura/tenants/*; do
  if [ -f "$dir/backend/.env" ]; then
    echo "Tenant: $dir"
    db_name=$(cat "$dir/backend/.env" | grep ^DB_NAME= | cut -d'=' -f2)
    db_user=$(cat "$dir/backend/.env" | grep ^DB_USER= | cut -d'=' -f2)
    db_pass=$(cat "$dir/backend/.env" | grep ^DB_PASSWORD= | cut -d'=' -f2)
    
    # 1. Add new columns and rename old ones (ignore errors if already done)
    docker exec cafe-shared-db mysql -u "$db_user" -p"$db_pass" "$db_name" -e "
      ALTER TABLE vouchers 
        CHANGE value discount_value DECIMAL(12,2) DEFAULT 0,
        CHANGE min_order min_transaction DECIMAL(12,2) DEFAULT 0,
        CHANGE start_date valid_from DATETIME DEFAULT NULL,
        CHANGE end_date valid_until DATETIME DEFAULT NULL,
        ADD COLUMN discount_type ENUM('fixed','percent') DEFAULT NULL AFTER type,
        ADD COLUMN member_only TINYINT(1) DEFAULT 0,
        ADD COLUMN usage_per_member INT DEFAULT 1;
    " || true

    # 2. Migrate data
    docker exec cafe-shared-db mysql -u "$db_user" -p"$db_pass" "$db_name" -e "
      UPDATE vouchers SET discount_type = IF(type='percentage', 'percent', 'fixed') WHERE type IN ('percentage', 'fixed');
      UPDATE vouchers SET type = 'total_discount' WHERE type IN ('percentage', 'fixed');
    " || true

    # 3. Change type ENUM
    docker exec cafe-shared-db mysql -u "$db_user" -p"$db_pass" "$db_name" -e "
      ALTER TABLE vouchers MODIFY type ENUM('free_item','item_discount','total_discount','bonus_points') NOT NULL;
    " || true
  fi
done
