#!/bin/bash
for dir in /opt/cafe-azzura/tenants/*; do
  if [ -f "$dir/backend/.env" ]; then
    echo "Tenant: $dir"
    db_name=$(cat "$dir/backend/.env" | grep ^DB_NAME= | cut -d'=' -f2)
    db_user=$(cat "$dir/backend/.env" | grep ^DB_USER= | cut -d'=' -f2)
    db_pass=$(cat "$dir/backend/.env" | grep ^DB_PASSWORD= | cut -d'=' -f2)
    
    docker exec cafe-shared-db mysql -u "$db_user" -p"$db_pass" "$db_name" -e "DESCRIBE post_galleries;"
  fi
done
