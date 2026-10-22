# Freelance Jobs Bot

بوت تيليجرام بيبعت المشاريع الجديدة من **كفيل، مستقل، نفذلي، خمسات، Freelancer** لأي حد يدوس `/start`.
شغال بالكامل على Cloudflare (Workers + Cron + D1) على الخطة المجانية.

## الملفات

| الملف | الوظيفة |
|---|---|
| `worker.js` | كل الكود (الـ scraper + الـ webhook + الإرسال) |
| `schema.sql` | جداول D1 (بتتعمل تلقائي لو نسيتها) |
| `wrangler.toml` | إعدادات النشر بالـ CLI (اختياري) |

## التشغيل من الـ Dashboard (من غير أي سطب)

1. **البوت:** من `@BotFather` اعمل بوت جديد (`/newbot`) وخد الـ token.
2. **D1:** Workers & Pages ← **D1 SQL Database** ← Create، سمّيها `jobs`.
3. **Worker:** Create Worker، الصق محتوى `worker.js`، Deploy.
4. **Binding:** Settings ← Bindings ← Add ← **D1 database**، الـ variable name لازم يكون `DB`، واختار `jobs`.
5. **Secrets:** Settings ← Variables and Secrets، ضيف (النوع Secret):
   - `BOT_TOKEN` : توكن البوت
   - `WEBHOOK_SECRET` : أي كلمة سر طويلة (حروف وأرقام و `_` و `-` بس)
   - `ADMIN_KEY` : كلمة سر تانية لصفحات الأدمن
   - `ADMIN_ID` : (اختياري) الـ chat id بتاعك عشان أمر `/stats`
6. **Cron:** Settings ← Triggers ← Cron Triggers ← Add، واكتب `* * * * *`.
7. **سجّل الـ webhook:** افتح في المتصفح:
   `https://<اسم-الworker>.workers.dev/setup?key=<ADMIN_KEY>`
   لازم يرجعلك JSON فيه `"ok": true` مرتين.
8. افتح البوت على تيليجرام وابعت `/start`.

## التشغيل بالـ CLI (بديل)

```bash
npm i -g wrangler
npx wrangler login
npx wrangler d1 create jobs            # حط الـ database_id في wrangler.toml
npx wrangler d1 execute jobs --remote --file=schema.sql
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
# بعدها افتح /setup?key=<ADMIN_KEY> مرة واحدة
```

## أوامر البوت (لأي يوزر)

| الأمر | الوظيفة |
|---|---|
| `/start` | تشغيل الإشعارات |
| `/stop` | إيقافها |
| `/sites` | تفعيل/إلغاء المواقع بأزرار (Freelancer مقفول افتراضياً) |
| `/keywords python, بوت` | فلتر بالكلمات (في العنوان والوصف) |
| `/keywords clear` | مسح الفلتر |
| `/status` | إعدادات اليوزر |
| `/stats` | عدد المستخدمين (للأدمن بس) |

## صفحات الأدمن

- `/?key=<ADMIN_KEY>` : بيعرض لكل موقع كام مشروع لقى وعينة من التفاصيل (للتأكد إن الـ parsers شغالة).
- `/?key=<ADMIN_KEY>&ping=<chat_id>` : رسالة اختبار.
- `/setup?key=<ADMIN_KEY>` : تسجيل الـ webhook والأوامر.

## ملاحظات مهمة

- **أول تشغيل لكل موقع** بيسجل أحدث ID من غير ما يبعت حاجة، فمفيش رسايل قديمة.
- **الأوراق على الخطة المجانية:** كل تشغيلة (دقيقة) فيها حد 50 طلب خارجي. الكود مظبوط على:
  - حد أقصى **10 مشاريع جديدة** و**30 رسالة** في الدقيقة (`MAX_NEW_PER_RUN`, `SEND_BATCH` أعلى الملف).
  - يعني تقريباً 1800 رسالة في الساعة. لو عدد اليوزرز كبر، الرسايل بتتأخر شوية بس مبتضيعش (بتستنى في الـ outbox).
  - لو احتجت أكتر، الخطة المدفوعة (Workers Paid) تسمح بحدود أعلى وترفع الأرقام دي.
- **حد الـ CPU:** الخطة المجانية بتسمح بـ 10ms CPU للتشغيلة. لو ظهرت أخطاء `exceeded CPU` في الـ Logs قولي، وأخفف الـ parsing.
- **اليوزر اللي يعمل block للبوت** بيتوقف تلقائي.
- **الخصوصية:** البوت بيخزن الـ chat id وإعدادات اليوزر (المواقع والكلمات) بس.
- **شروط الاستخدام:** راجع شروط كل موقع بخصوص جلب الصفحات، وبلاش تكتر الطلبات (الفاصل دقيقة).
- مستقل ونفذلي وخمسات الـ parsers بتاعتهم مبنية على نمط الروابط والـ meta tags، فلو موقع ظهر `found: 0` أو التفاصيل ناقصة في صفحة الاختبار، يتظبط الـ regex بتاعه.
