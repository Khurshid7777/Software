// Staff UI is Russian-only, like the operators' and moderators' bot cards.
import { t, type District } from "@ishonch/shared/client";

export const districtName = (d: string | null) => (d ? t("ru", `district.${d as District}`) : "—");

export const STEP_LABEL: Record<string, string> = {
  meeting_requested: "Предложили встречу",
  meeting_accepted: "Договорились о встрече",
  meeting_bought: "Купили на встрече",
  terms_accepted: "Приняли условия",
  catalog_search: "Искали в каталоге",
  listing_viewed: "Открыли объявление",
  buyer_contacted_seller: "Написали продавцу",
  order_created: "Оформили доставку",
  order_delivered: "Получили товар",
  review_created: "Оставили отзыв",
  listing_draft_created: "Начали объявление",
  listing_published: "Опубликовали",
  order_confirmed: "Подтвердили заказ",
  listing_sold_platform: "Продали через Ishonch",
};

export const FEATURE_LABEL: Record<string, string> = {
  "check.extract": "Проверка: разбор",
  "check.report": "Проверка: отчёт",
  "listing.analyze": "Объявление: анализ фото",
  "listing.generate": "Объявление: текст",
  "listing.moderate": "Модерация",
  "assistant.query": "Помощник: запрос",
  "assistant.recommend": "Помощник: подбор",
  "assistant.compare": "Помощник: сравнение",
};

export const CANCEL_LABEL: Record<string, string> = {
  buyer_cancelled: "Покупатель отменил",
  seller_declined: "Продавец отказался",
  reserved_by_other: "Товар забронирован другим",
  banned: "Участник заблокирован",
  unknown: "Без причины (оператор)",
};

export const MODE_LABEL: Record<string, string> = {
  delivery_only: "Только доставка",
  cod_seller: "Оплата при получении",
  cod_platform: "Наличные курьеру Ishonch (не используется)",
};

export const STATUS_LABEL: Record<string, string> = {
  new: "Ждёт продавца",
  confirmed: "Подтверждён",
  courier_assigned: "Курьер назначен",
  picked_up: "У курьера",
  delivered: "Доставлен",
  returned: "Возврат",
  cancelled: "Отменён",
};

export const NEXT_LABEL: Record<string, string> = {
  courier_assigned: "🚚 Курьер назначен",
  picked_up: "📦 Забрал",
  delivered: "✅ Доставлено",
  returned: "↩️ Возврат",
  cancelled: "✖️ Отменить",
};

export const REASON_LABEL: Record<string, string> = {
  prohibited_item: "Запрещённый товар",
  contact_info: "Контакты в тексте",
  misleading: "Не соответствует / цена-приманка",
  offensive: "Оскорбления",
  not_an_item: "Не товар",
  stock_photos: "Фото из интернета",
  duplicate_photos: "Фото как у другого продавца",
  duplicate_text: "Текст как у другого продавца",
  duplicate_imei: "IMEI как у другого продавца",
  imei_listed: "IMEI в базе утерянных/украденных",
  complaints: "Жалобы",
  other: "Другое",
  scam: "Мошенничество",
  prohibited: "Запрещённый товар",
  wrong_info: "Неверное описание",
  duplicate: "Дубликат",
  sold: "Уже продано",
};

export const INSPECTION_LABEL: Record<string, string> = {
  matches_description: "Соответствует описанию",
  screen: "Экран без дефектов",
  camera: "Камеры работают",
  biometrics: "Face ID / отпечаток",
  imei_match: "IMEI совпадает (*#06#)",
  battery: "Аккумулятор как в объявлении",
  powers_on: "Включается и определяется",
  load_test: "Тест под нагрузкой: без артефактов и перегрева",
  dead_pixels: "Нет битых пикселей и засветов",
  noise: "Работает без постороннего шума и запаха",
  no_leaks: "Нет протечек, ржавчины и вмятин",
};
