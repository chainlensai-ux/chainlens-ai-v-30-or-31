@echo off
cd /d "C:\Users\User\Downloads\chainlens-ai-v-30-or-31-main\chainlens-ai-v-30-or-31-main"
git pull origin main
git add -A
git commit -m "auto save %date% %time%"
git push origin main
echo Done - live on Vercel
pause