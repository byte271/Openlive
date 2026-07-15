/**
 * Openlive 26.7.14.1 — visual-cards.js
 *
 * Rich visual card schemas and render helpers for the transcript. Mirrors
 * GPT-Live's inline rich cards (weather, stock, sports, maps) that surface
 * during voice conversations.
 *
 * Each card has:
 *   - kind: identifies the layout template
 *   - id: local stable id for keyed rendering
 *   - title: headline text
 *   - fields: kind-specific structured data
 *   - attribution: optional source citation
 *
 * The render helper returns a DOM node. The ui.js layer appends it to the
 * transcript drawer. Cards are intentionally text-and-emoji only — no
 * external images — to keep the runtime fully self-hostable.
 *
 * Card kinds supported:
 *   - weather: current conditions + forecast
 *   - stock: ticker + price + change
 *   - sports: score + status
 *   - maps: place + address + static-map placeholder
 *   - web_search: query + top results
 *   - code: language + code block
 *   - translation: source + target language + translated text
 */

let _nextCardId = 1;

/**
 * @typedef {Object} VisualCard
 * @property {string} id
 * @property {"weather" | "stock" | "sports" | "maps" | "web_search" | "code" | "translation" | "generic"} kind
 * @property {string} title
 * @property {Record<string, string | number>} fields
 * @property {string | null} attribution
 * @property {number} createdAt
 */

/**
 * Build a weather card.
 *
 * @param {Object} data
 * @param {string} data.location
 * @param {number} data.temperatureC
 * @param {string} data.condition
 * @param {number} [data.humidity]
 * @param {number} [data.windKph]
 * @param {string} [attribution]
 * @returns {VisualCard}
 */
export function weatherCard(data, attribution = null) {
  return makeCard("weather", `Weather · ${data.location}`, {
    location: data.location,
    temperature: `${data.temperatureC}°C`,
    condition: data.condition,
    humidity: data.humidity != null ? `${data.humidity}%` : "—",
    wind: data.windKph != null ? `${data.windKph} km/h` : "—",
  }, attribution);
}

/**
 * Build a stock card.
 *
 * @param {Object} data
 * @param {string} data.symbol
 * @param {number} data.price
 * @param {number} data.changePercent
 * @param {string} [data.currency]
 * @param {string} [attribution]
 * @returns {VisualCard}
 */
export function stockCard(data, attribution = null) {
  const arrow = data.changePercent >= 0 ? "▲" : "▼";
  return makeCard("stock", `Stock · ${data.symbol}`, {
    symbol: data.symbol,
    price: `${data.currency ?? "$"}${data.price.toFixed(2)}`,
    change: `${arrow} ${Math.abs(data.changePercent).toFixed(2)}%`,
  }, attribution);
}

/**
 * Build a sports score card.
 *
 * @param {Object} data
 * @param {string} data.league
 * @param {string} data.home
 * @param {string} data.away
 * @param {number} data.homeScore
 * @param {number} data.awayScore
 * @param {string} data.status
 * @param {string} [attribution]
 * @returns {VisualCard}
 */
export function sportsCard(data, attribution = null) {
  return makeCard("sports", `${data.league} · ${data.home} vs ${data.away}`, {
    league: data.league,
    home: `${data.home} ${data.homeScore}`,
    away: `${data.away} ${data.awayScore}`,
    status: data.status,
  }, attribution);
}

/**
 * Build a maps card.
 *
 * @param {Object} data
 * @param {string} data.place
 * @param {string} data.address
 * @param {string} [data.staticMapUrl]
 * @param {string} [attribution]
 * @returns {VisualCard}
 */
export function mapsCard(data, attribution = null) {
  return makeCard("maps", `Maps · ${data.place}`, {
    place: data.place,
    address: data.address,
    staticMapUrl: data.staticMapUrl ?? "",
  }, attribution);
}

/**
 * Build a web-search results card.
 *
 * @param {Object} data
 * @param {string} data.query
 * @param {{title: string, url: string, snippet: string}[]} data.results
 * @param {string} [attribution]
 * @returns {VisualCard}
 */
export function webSearchCard(data, attribution = null) {
  return makeCard("web_search", `Search · ${data.query}`, {
    query: data.query,
    results: data.results.slice(0, 3).map((r) => `${r.title} — ${r.snippet}`).join("\n"),
  }, attribution);
}

/**
 * Build a code card.
 *
 * @param {Object} data
 * @param {string} data.language
 * @param {string} data.code
 * @param {string} [data.output]
 * @param {string} [attribution]
 * @returns {VisualCard}
 */
export function codeCard(data, attribution = null) {
  return makeCard("code", `Code · ${data.language}`, {
    language: data.language,
    code: data.code,
    output: data.output ?? "",
  }, attribution);
}

/**
 * Build a translation card.
 *
 * @param {Object} data
 * @param {string} data.sourceText
 * @param {string} data.sourceLang
 * @param {string} data.targetText
 * @param {string} data.targetLang
 * @param {string} [attribution]
 * @returns {VisualCard}
 */
export function translationCard(data, attribution = null) {
  return makeCard("translation", `Translation · ${data.sourceLang} → ${data.targetLang}`, {
    source: data.sourceText,
    target: data.targetText,
    sourceLang: data.sourceLang,
    targetLang: data.targetLang,
  }, attribution);
}

/**
 * Build a generic fallback card for unknown tool results.
 *
 * @param {Object} data
 * @param {string} data.title
 * @param {string} data.body
 * @param {string} [attribution]
 * @returns {VisualCard}
 */
export function genericCard(data, attribution = null) {
  return makeCard("generic", data.title, { body: data.body }, attribution);
}

/**
 * Internal card factory.
 *
 * @param {VisualCard["kind"]} kind
 * @param {string} title
 * @param {Record<string, string | number>} fields
 * @param {string | null} attribution
 * @returns {VisualCard}
 */
function makeCard(kind, title, fields, attribution) {
  return {
    id: `v${_nextCardId++}`,
    kind,
    title,
    fields,
    attribution,
    createdAt: Date.now(),
  };
}

/**
 * Glyph for a card kind. Used as the avatar in the transcript bubble.
 *
 * @param {VisualCard["kind"]} kind
 * @returns {string}
 */
export function glyphForKind(kind) {
  const glyphs = {
    weather: "☀",
    stock: "📈",
    sports: "⚽",
    maps: "📍",
    web_search: "🔍",
    code: "▶",
    translation: "🌐",
    generic: "◆",
  };
  return glyphs[kind] ?? glyphs.generic;
}
