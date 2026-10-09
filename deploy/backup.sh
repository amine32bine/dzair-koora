#!/bin/sh
# نسخة احتياطية يومية لبيانات الحسابات: أضفه إلى cron:  0 3 * * * /path/to/deploy/backup.sh
cd "$(dirname "$0")/.." || exit 1
mkdir -p backups
tar czf "backups/data-$(date +%F).tar.gz" data
ls -1t backups/data-*.tar.gz | tail -n +15 | xargs -r rm
