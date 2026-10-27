# ТЗ для генерации картинок Ishonch (ChatGPT / gpt-image)

Документ целиком вставляется в ChatGPT. Картинки делаются по одной или пачками по разделам; готовые файлы складываются в папку `art/` с именами из таблиц ниже, и Claude подключает их в Mini App.

---

## 0. Сообщение для GPT (вставить первым)

> Ты — арт-директор и 3D-иллюстратор мобильного приложения **Ishonch** («Доверие» по-узбекски). Это Telegram Mini App в Ташкенте: люди покупают и продают **б/у электронику** (телефоны, ноутбуки, наушники, приставки, бытовую технику). Ishonch не берёт денег: он связывает покупателя и продавца и даёт покупателю факты о товаре — паспорт состояния, видео-проверку, 10 минут на осмотр при получении.
>
> Настроение: **спокойствие, честность, порядок, немного праздника**. Ориентиры: витрина Walmart (синий + жёлтая искра, крупные товары) и сдержанность Apple (много воздуха, мягкий свет, чистые формы).
>
> Сгенерируй картинки строго по списку ниже. Для каждой соблюдай общий стиль из раздела 1, размер и фон из таблицы и промпт из раздела 3. **Никакого текста, букв, цифр, логотипов брендов и водяных знаков на изображениях** — подписи добавляет приложение на двух языках. Если модель всё же нарисовала текст или логотип — перегенерируй.
>
> После каждой картинки напиши её имя файла из таблицы, чтобы я сохранил её под этим именем.

---

## 1. Общий стиль (добавлять к каждому промпту)

**Style anchor (EN):**
```
Soft 3D render, clay-meets-glass look, smooth rounded geometry, subtle bevels, matte plastic with a few frosted-glass accents, gentle global illumination, soft contact shadows, no harsh specular highlights, clean studio composition with generous negative space, brand palette: cobalt blue #0053E2, deep navy #07204F, warm yellow spark #FFC220, soft white #F6F7FB, accent green #1A8A5A. Calm, trustworthy, premium but friendly. No text, no letters, no numbers, no brand logos, no watermarks, no UI screenshots with readable text.
```

**Палитра:**

| Роль | Цвет |
|---|---|
| Основной синий | `#0053E2` |
| Глубокий синий (тени, тёмные градиенты) | `#07204F` |
| Жёлтая «искра» (акценты, блики, звёздочка ✦) | `#FFC220` |
| Фон светлой темы | `#F6F7FB` |
| Фон тёмной темы (графит) | `#0B0D12` |
| Зелёный «проверено / хорошо» | `#1A8A5A` |
| Красный «осторожно» (очень редко) | `#D92D20` |

**Правила:**
- Устройства **без логотипов и узнаваемого брендинга** (никаких яблок, надписей Samsung, PlayStation и т. п.). Форма может напоминать класс устройства, но не копировать конкретную модель.
- Без людей с лицами. Допустимы руки (без колец и татуировок), силуэты.
- Без текста на экранах устройств: экраны либо светятся мягким синим градиентом, либо показывают абстрактные плашки и иконки (галочка, щит, батарея как шкала без цифр).
- Свет сверху-слева, тени мягкие, вниз-вправо — одинаково во всех картинках.
- Одна и та же «искра» ✦ (четырёхлучевая звезда #FFC220) как фирменный элемент — можно в фонах и иллюстрациях, не больше одной-двух на картинку.

---

## 2. Технические требования

| Параметр | Значение |
|---|---|
| Размеры генерации | 1024×1024 (квадрат), 1536×1024 (горизонталь), 1024×1536 (вертикаль) — Claude сам обрежет и ужмёт |
| Прозрачность | для иконок, иллюстраций и товаров — **прозрачный фон (PNG)**; для фонов — сплошной |
| Важное в кадре | объект по центру, отступ от краёв не меньше 12 %, ничего важного у краёв — картинки обрезаются под разные экраны |
| Тёмная тема | где в таблице стоит «+dark», нужна вторая версия под фон `#0B0D12` (тот же кадр, свет и тени под тёмный фон) |
| Формат сдачи | PNG, имя файла строго из таблицы, папка `art/<раздел>/` |
| Не сжимать | оптимизацию в WebP/AVIF и размеры @2x/@3x делает Claude |

---

## 3. Список картинок и промпты

### A. Фоны (`art/bg/`)

| Файл | Размер | Где в приложении |
|---|---|---|
| `bg-hero-light.png`, `bg-hero-dark.png` | 1536×1024 | Блок «Покупайте спокойно» на главной — под белым текстом |
| `bg-brandbar.png` | 1536×1024 | Синяя шапка витрины с поиском |
| `bg-page-light.png`, `bg-page-dark.png` | 1024×1536 | Едва заметная текстура всего фона страницы |
| `bg-how.png` (+dark) | 1536×1024 | Шапка экрана «Как проходит проверка» |
| `bg-sell.png` (+dark) | 1536×1024 | Баннер «Продайте за 2 минуты» |

**A1. Hero (`bg-hero-*`)**
```
Abstract background for a mobile app hero card. Deep navy #07204F to cobalt blue #0053E2 diagonal gradient, soft volumetric light from the top-right, a few large blurred translucent glass spheres and rounded pebbles floating in depth, one small glowing four-pointed yellow star #FFC220 in the upper right third. The left half must stay calm and dark enough for white text on top. Smooth, premium, no hard edges. [style anchor]
```
Тёмная версия: тот же кадр, но общий тон темнее, ближе к `#0B0D12`, свет приглушён.

**A2. Шапка витрины (`bg-brandbar.png`)**
```
Wide abstract header background, rich cobalt blue #0053E2 with a subtle lighter diagonal sheen and very soft wave-like folds of satin, faint micro-noise grain, a tiny yellow #FFC220 spark glint near the top right. Uniform enough to place a white search bar in the lower middle. [style anchor]
```

**A3. Фон страницы (`bg-page-*`)**
```
Extremely subtle seamless-looking background texture for an app page. Light theme: off-white #F6F7FB with a very soft blue glow from the top center fading out by one third of the height, almost invisible large rounded shapes. Contrast must be very low: white cards placed on top must still look clean. [style anchor]
```
Тёмная версия: графит `#0B0D12`, слабое синее свечение сверху.

**A4. «Как проходит проверка» (`bg-how-*`)**
```
Calm wide illustration background: a soft blue-to-white gradient with a large translucent frosted-glass shield shape on the right, a stopwatch ring made of light behind it, one small yellow spark. Left two thirds stay clean for a heading. [style anchor]
```

**A5. Баннер продажи (`bg-sell-*`)**
```
Wide banner background: dark graphite #0B0D12 with a soft spotlight from the top, a used smartphone and a camera lying at an angle on the right side with soft reflections, a gentle yellow #FFC220 rim light. Left side empty for text. No logos. [style anchor]
```

---

### B. 3D-иконки категорий (`art/categories/`, 1024×1024, прозрачный фон)

Сейчас на витрине — линейные SVG в кружках. 3D-версии ставятся в те же кружки, поэтому объект должен **занимать 70 % кадра, вид три четверти, сверху-слева**. Один стиль для всех 12.

Общий промпт (подставить предмет):
```
Single 3D icon of <ITEM>, three-quarter view from the upper left, centered, occupying about 70% of the frame, transparent background, matte clay material in the main tint <TINT> with soft white and frosted-glass details, tiny yellow #FFC220 accent somewhere on the object, soft contact shadow under it. No text, no logos. [style anchor]
```

| Файл | `<ITEM>` | `<TINT>` |
|---|---|---|
| `cat-smartphone.png` | a modern smartphone with a glowing blue screen | cobalt blue #0053E2 |
| `cat-laptop.png` | an open laptop | violet #6B4EE6 |
| `cat-tablet.png` | a tablet with a stylus | teal #0A8FA3 |
| `cat-headphones.png` | over-ear headphones | raspberry #D6336C |
| `cat-smartwatch.png` | a smartwatch with a sport band | green #1A8A5A |
| `cat-console.png` | a game controller | orange #E0591E |
| `cat-tv.png` | a slim TV on a stand | indigo #3B5BDB |
| `cat-camera.png` | a mirrorless camera with a lens | graphite #5C5F66 |
| `cat-pc_parts.png` | a graphics card with two fans | green #2F9E44 |
| `cat-monitor.png` | a desktop monitor | blue #1971C2 |
| `cat-home_appliance.png` | a coffee machine | pink #C2255C |
| `cat-large_appliance.png` | a front-loading washing machine | teal #0B7285 |

---

### C. Иллюстрации экранов (`art/illustrations/`, 1024×1024, прозрачный фон, +dark не нужен)

Заменяют эмодзи в пустых состояниях и украшают ключевые экраны. Композиция компактная, «предмет на облачке».

| Файл | Где | Промпт (+ style anchor) |
|---|---|---|
| `empty-search.png` | «Ничего не нашли» в каталоге | `A friendly magnifying glass hovering over an empty soft blue platform, a tiny yellow spark nearby, playful but calm.` |
| `empty-favorites.png` | Пустое «Избранное» | `A soft 3D heart made of frosted glass resting on a small cushion, gentle glow.` |
| `empty-orders.png` | Нет заказов | `An open empty cardboard parcel box with soft light coming out, small yellow spark.` |
| `empty-compare.png` | Пустое «Сравнение» | `Balanced scales made of blue clay with two empty glass bowls, symmetrical, calm.` |
| `empty-wanted.png` | «Куплю» без запросов | `A raised hand silhouette made of soft clay holding a small glowing smartphone, no face.` |
| `load-error.png` | Ошибка загрузки | `A small satellite dish with a gentle wavy signal line, slightly tilted, calm not alarming, muted blue.` |
| `how-step-1.png` | Шаг «Договариваетесь» | `Two chat bubbles of different blues overlapping, one with a tiny check mark shape, soft 3D.` |
| `how-step-2.png` | Шаг «10 минут на осмотр» | `A stopwatch in cobalt blue lying next to a smartphone, the stopwatch ring partly filled with yellow.` |
| `how-step-3.png` | Шаг «Не подошло — не платите» | `A wallet that stays closed with a soft green check badge floating above it, and a small parcel with a curved return arrow made of clay.` |
| `how-step-4.png` | Шаг «3 дня защиты» | `A frosted-glass shield with a soft green check inside, three small glowing dots under it.` |
| `passport.png` | Шапка паспорта товара | `A small booklet like a product passport with a big rounded letter-grade badge shape (no letter), a check list made of abstract bars, blue and white.` |
| `video-passport.png` | Блок видео-паспорта у продавца | `A smartphone on a small tripod filming another smartphone, a soft red record dot, abstract frames floating out like film strips.` |
| `verified.png` | «Проверено курьером» | `A delivery parcel with a large green check seal, a courier bag strap visible, no person.` |

**Сценарий видео-паспорта** — пять маленьких картинок для шагов в редакторе продавца (`art/video-steps/`, 1024×1024, прозрачный фон). Экраны без цифр и текста, только понятные пиктограммы:

| Файл | Промпт (+ style anchor) |
|---|---|
| `step-device_on.png` | `A smartphone being switched on, screen lighting up with a soft blue glow, a finger pressing the side button.` |
| `step-identifier.png` | `A smartphone screen showing an abstract dial pad shape with a highlighted row of blank pills (no digits), small barcode-like lines.` |
| `step-battery.png` | `A smartphone screen showing a big abstract battery bar filled mostly green, no numbers.` |
| `step-account.png` | `A smartphone screen showing an abstract user avatar circle with an open padlock next to it.` |
| `step-body.png` | `A smartphone shown from three angles (front, side, back) in a soft circular rotation path.` |

---

### D. Демо-фото товаров (`art/demo/`, 1024×1024, **сплошной светлый фон** `#F2F4F8`)

> **Статус (27.10.2026):** первые 17 фото получены и подключены. Они лежат в `apps/api/test/demo-photos/` и подставляются сидом демо-каталога. Весы стоят в пустом «Сравнении». **Ещё нужны:** `demo-lenovo_legion.png`, `demo-hp_office.png`, `demo-ps5.png` и `demo-ryzen5600.png` (процессор в коробке). Пока у этих товаров аккуратная заглушка с иконкой категории.

Сейчас в демо-каталоге вместо фото — цветные узоры. Нужны реалистичные «фото как у продавца»: б/у вещь на столе, мягкий дневной свет, лёгкие следы использования. **Без логотипов**, форма — узнаваемый класс устройства.

Общий промпт:
```
Realistic product photo of a used <ITEM>, lying on a light neutral table, soft daylight from a window on the left, shallow depth of field, slight natural signs of use, clean and honest, as if a careful seller photographed it for a listing. No logos, no brand names, no text on the screen. Square composition, item centered.
```

| Файл | `<ITEM>` |
|---|---|
| `demo-mba_m1.png` | thin silver aluminium laptop, lid half open |
| `demo-lenovo_legion.png` | black gaming laptop with a subtle blue keyboard backlight |
| `demo-hp_office.png` | plain dark grey budget laptop, closed, with a charger |
| `demo-iphone13.png` | smartphone with a dual camera, blue colour, in a clear case next to its box |
| `demo-redmi_note13.png` | new smartphone in black, still with protective film, box nearby |
| `demo-airpods_pro2.png` | white wireless earbuds in an open charging case |
| `demo-ps5.png` | white-and-black home game console standing upright with two controllers |
| `demo-rtx3060.png` | graphics card with two fans, back plate visible |
| `demo-ryzen5600.png` | desktop processor chip in its open retail box |
| `demo-odyssey_g5.png` | curved 27-inch gaming monitor on a desk |
| `demo-robot_vacuum.png` | white round robot vacuum cleaner on a parquet floor |
| `demo-coffee_machine.png` | silver-black bean-to-cup coffee machine on a kitchen counter |
| `demo-washer.png` | white front-loading washing machine in a bathroom |
| `demo-fridge.png` | tall silver two-door fridge in a kitchen |

---

### E. Telegram и соцсети (`art/brand/`)

| Файл | Размер | Промпт (+ style anchor) |
|---|---|---|
| `bot-avatar.png` | 1024×1024 | `App avatar: a single bold four-pointed star #FFC220 inside a rounded shield silhouette, on a solid cobalt blue #0053E2 background, centered, simple, readable at 48 px.` |
| `bot-cover.png` | 1536×1024 | `Telegram bot description picture: a neat arrangement of a used smartphone, laptop, earbuds and a game controller on a cobalt blue surface, a frosted-glass shield with a green check floating above them, one yellow spark. Leave the top third calm for a title.` |
| `share-card.png` | 1536×1024 | `Link preview background for a shared listing: soft blue gradient with a white rounded card shape in the center (empty, for a product photo), a small glass shield in the corner, a yellow spark.` |
| `splash.png` | 1024×1536 | `Vertical splash: deep navy to cobalt gradient, a large glowing four-pointed yellow star at the center with soft light rays, small floating gadgets (phone, earbuds, controller) far in the background, blurred.` |

---

## 4. Порядок работы

1. **Сначала пробник:** `bg-hero-light.png`, `cat-smartphone.png`, `empty-compare.png`, `demo-iphone13.png`. Пришлите их Claude — проверим стиль на живых экранах, поправим промпты.
2. Потом остальное разделами A → B → C → D → E.
3. Если картинка «уплыла» по стилю, добавьте к промпту: `Match the exact style, lighting and materials of the previous images in this chat.`
4. Сложите файлы в папку `art/` по разделам и загрузите в репозиторий (или пришлите архивом) — Claude сожмёт их в WebP/AVIF, разложит по @2x/@3x и подключит.

## 5. Чек-лист приёмки

- [ ] Нет текста, цифр, логотипов и водяных знаков.
- [ ] Цвета из палитры, свет сверху-слева.
- [ ] Иконки и иллюстрации на прозрачном фоне, объект по центру с отступами.
- [ ] Фоны для текста: та зона, куда ляжет текст, спокойная и контрастная.
- [ ] Для «+dark» есть тёмная версия.
- [ ] Имена файлов совпадают с таблицами.
