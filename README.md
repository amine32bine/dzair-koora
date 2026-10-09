# جزائري كورة — من الصفر إلى المتجرين (تطوير عبد القادر أمين، الجزائر)

## ما تحتاجه
| الشيء | الكلفة التقريبية | لماذا |
|---|---|---|
| دومين (مثل `dzairkoora.com`) | ~10$ سنويًا | عنوان https ثابت للخادم |
| VPS (Hetzner / DigitalOcean / OVH) | ~5$ شهريًا | يشغّل الخادم 24 ساعة |
| API-Football (خطة مدفوعة) | حسب الخطة | النتائج الحية. المجانية 100 طلب/يوم لا تكفي |
| Firebase (Spark) | مجاني | إشعارات الهدف والتطبيق مغلق |
| Google Play | 25$ مرة واحدة | نشر أندرويد |
| Apple Developer + ماك (أو بناء سحابي مثل Codemagic) | 99$ سنويًا | نشر iOS |
| بريد (Resend أو Brevo) | مجاني للبداية | رموز تأكيد الحساب |

## 0) تطبيق على هاتفك اليوم، مجانًا وبدون متاجر
التطبيق قابل للتثبيت من المتصفح (PWA)، ويظهر على شاشة هاتفك بأيقونته كأي تطبيق.
1. شغّل الخادم على حاسوبك: `start.bat` (ضع `API_FOOTBALL_KEY` في `.env` للنتائج الحية).
2. نافذة ثانية: ثبّت cloudflared (`winget install Cloudflare.cloudflared` على ويندوز) ثم `cloudflared tunnel --url http://localhost:8080` — يعطيك رابط `https://....trycloudflare.com` مجانًا وبدون حساب.
3. افتح الرابط على هاتفك: أندرويد (كروم) ← «تثبيت التطبيق»، آيفون (سفاري) ← مشاركة ← «إضافة إلى الشاشة الرئيسية».
- حدودها: الرابط يتغيّر كل مرة، والحاسوب يجب أن يبقى شغّالًا، وإشعارات الهدف تصل وهو مفتوح فقط. للاستمرار الدائم والمتاجر انتقل إلى الخطوة 2.

## 1) تجربة محلية (5 دقائق)
`start.bat` (ويندوز) أو `./start.sh` → http://localhost:8080  — بدون أي مفتاح تعمل الصلاة والحسابات (الرمز يظهر في نافذة الخادم).

## 2) نشر الخادم على VPS
1. وجّه الدومين: سجل `A` لـ `api.دومينك.com` إلى عنوان الـ VPS.
2. على الـ VPS ثبّت Docker، وانسخ مجلد المشروع، ثم:
   ```
   cp .env.example .env     # عبّئ: DOMAIN، API_FOOTBALL_KEY، MAIL_FROM + RESEND_API_KEY (أو BREVO_API_KEY)
   docker compose up -d --build
   ```
3. افتح `https://api.دومينك.com/api/health` (شهادة https تُنشأ تلقائيًا عبر Caddy).
4. نسخ احتياطي يومي: أضف `deploy/backup.sh` إلى cron (الحسابات في مجلد `data`).
5. حجم الخطة: الخادم يستعلم عن كل المباريات الحية بطلب واحد كل `POLL_MS` (60 ثانية = 1440 طلبًا يوميًا).

## 3) إشعارات الهدف (Firebase)
1. أنشئ مشروعًا في console.firebase.google.com.
2. Project settings ← Service accounts ← Generate new private key ← احفظه باسم `secrets/firebase.json` على الـ VPS، ثم `docker compose restart app`. يظهر في السجل: «إشعارات Firebase مفعّلة».
3. أضف تطبيق Android بالمعرّف `dz.dzairkoora.app` وحمّل `google-services.json`.
4. أضف تطبيق iOS بنفس المعرّف وحمّل `GoogleService-Info.plist`، ثم ارفع مفتاح APNs (من حساب Apple) في Firebase ← Cloud Messaging.

## 4) بناء التطبيقين
```
cd mobile
npm install
node sync.js https://api.دومينك.com
npx cap add android && npx cap add ios      # مرة واحدة
npm run assets                               # الأيقونة وشاشة البدء
```
- أندرويد: ضع `google-services.json` في `android/app/` ثم `npm run android` ← Build ← Generate Signed Bundle (AAB). احتفظ بملف التوقيع (keystore) وكلمته في مكان آمن، فبدونه لا تستطيع تحديث التطبيق.
- iOS (ماك): `npm run ios` ← أضف `GoogleService-Info.plist` عبر Xcode، وفي Signing & Capabilities فعّل **Push Notifications** و**Background Modes ← Remote notifications**، ثم Product ← Archive ← Distribute.
- عند تغيير الأيقونة أو الاسم أو الخادم أعد `node sync.js` ثم `npx cap sync`.

## 5) النشر في المتجرين
نصوص المتجر وإجابات استبيانات الخصوصية جاهزة في `STORE_LISTING.md`.
- Google Play: الحسابات الشخصية الجديدة تحتاج اختبارًا مغلقًا (12 مختبرًا لمدة 14 يومًا) قبل الإنتاج.
- App Store: آبل قد ترفض تطبيقًا هو «صفحة ويب فقط». ما يقوّي طلبك: إشعارات الأهداف الأصلية، حسابات مستخدمين، مواقيت صلاة تعمل دون إنترنت، حذف الحساب من داخل التطبيق.
- في الاثنين: ضع بريد التواصل في `public/privacy.html`، ورابط السياسة `https://api.دومينك.com/privacy`.

## بعد النشر
- تحديث الواجهة: عدّل `public/` ثم أعد `node sync.js` وابنِ إصدارًا جديدًا (ارفع versionCode / Build number).
- تحديث الخادم: `git pull && docker compose up -d --build` (لا يحتاج المتجر).
- بطولة جديدة: `EXTRA_LEAGUES=ID:الاسم` في `.env` (ابحث عن المعرّف: `/api/leagues/search?q=jordan`) ثم أعد تشغيل الخادم.
- مراقبة: جهّز UptimeRobot (مجاني) على `/api/health`.
