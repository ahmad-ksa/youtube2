# YouTube LG

تطبيق يوتيوب لشاشات LG (webOS) على طريقة **SmartTube**: واجهته ومشغّله خاصان به، ويشغّل بأعلى جودة متاحة (حتى 4K/8K و60 إطار وHDR) بدون إعلانات.

- مشغّل خاص (Shaka + SABR) مع **قفل الجودة** واختيار الترميز (AV1 / VP9 / H.264) وحجم التخزين المؤقت.
- التحكم في السرعة، الترجمة، واستكمال المشاهدة من حيث توقفت.
- **SponsorBlock** لتخطي الرعايات والمقدمات وغيرها.
- بحث مع اقتراحات، القنوات، قوائم التشغيل، والمقترحات أثناء المشاهدة.
- تسجيل دخول اختياري بالرمز (youtube.com/activate) لعرض الاشتراكات والسجل.
- زر **الأزرق** في الريموت يعرض سجل الأخطاء للتشخيص.

## التحديث التلقائي
GitHub Actions يحدّث مكتبات يوتيوب يوميًا (youtubei.js و googlevideo و bgutils-js)، ويبني إصدار جديد إذا تغيّرت.
وكل يوم يفحص إصدارات SmartTube ويفتح تذكرة بالتغييرات الجديدة.

## التثبيت
1. فعّل **Developer Mode** على الشاشة، وثبّت **Homebrew Channel** عن طريق [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop).
2. في Homebrew Channel افتح Settings ثم Add repository وأضف:
   `https://raw.githubusercontent.com/ahmad-ksa/youtube2/repo/apps.json`
3. ثبّت **YouTube LG**، والتحديثات تظهر هناك تلقائيًا.

أو حمّل ملف `.ipk` من [Releases](https://github.com/ahmad-ksa/youtube2/releases/latest) وثبّته بـ Dev Manager.

## المصادر
- الفكرة: [SmartTube](https://github.com/yuliskov/SmartTube)
- [youtubei.js](https://github.com/LuanRT/YouTube.js) و [googlevideo](https://github.com/LuanRT/googlevideo) و [BgUtils](https://github.com/LuanRT/BgUtils) (MIT)
- [Shaka Player](https://github.com/shaka-project/shaka-player) (Apache-2.0)
