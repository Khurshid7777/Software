// Server / tests entry: both dictionaries are bundled and registered on import.
import ru from "../i18n/ru.json" with { type: "json" };
import uz from "../i18n/uz.json" with { type: "json" };
import { registerDictionary } from "./i18n-core.js";

registerDictionary("ru", ru);
registerDictionary("uz", uz);

export * from "./i18n-core.js";
