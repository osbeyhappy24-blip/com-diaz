#!/data/data/com.termux/files/usr/bin/bash
# Uso: ./set-times.sh "10:30"
#      ./set-times.sh "09:00,15:00,21:00"
#      ./set-times.sh "08:00,12:00,18:00,21:00"

if [ -z "$1" ]; then
  echo "❌ Uso: ./set-times.sh \"HH:MM\" o \"HH:MM,HH:MM,...\""
  exit 1
fi

TIMES_JSON=$(echo "\"$1\"" | sed 's/,/","/g')

echo "⏰ Configurando horarios: $1"
echo "   JSON: [$TIMES_JSON]"

node -e "
const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');
s = s.replace(/publishTimes:\s*\[[^\]]*\]/, 'publishTimes: [' + process.argv[1] + ']');
fs.writeFileSync('server.js', s);
console.log('✅ server.js actualizado');
" "[$TIMES_JSON]"

node --check server.js || { echo "❌ Error de sintaxis"; exit 1; }

git add .
git commit -m "chore: horarios actualizados a $1"
git push origin main

echo ""
echo "🎉 Listo. Render desplegará en ~2 min."
echo "   Horarios activos: $1"
