//! Built-in agent tools shared by the agent API and the voice path.

use std::net::IpAddr;
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::typo::correct_typos;

/// A source citation for search / browse results (shown in transcript cards).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Citation {
    pub title: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub snippet: String,
}

/// Run deterministic tools for an intent. Returns (answer, tools_used).
pub async fn try_builtin_tools(client: &Client, intent: &str) -> Option<(String, Vec<String>)> {
    let intent = correct_typos(intent.trim());
    let intent = intent.trim();
    if intent.is_empty() {
        return None;
    }

    // Identity first — never web-search "你是谁" / "who are you".
    if looks_like_identity(intent) {
        return Some((identity_reply(intent), vec!["identity".into()]));
    }

    if looks_like_math(intent) {
        if let Some(expr) = extract_math_expr(intent) {
            return match simple_eval(&expr) {
                Ok(v) => Some((format!("{expr} = {v}"), vec!["calculator".into()])),
                Err(e) => Some((format!("calc error: {e}"), vec!["calculator".into()])),
            };
        }
    }

    if looks_like_time(intent) {
        return Some((format!("Current UTC time: {}", chrono_lite_now()), vec!["get_time".into()]));
    }

    if looks_like_search(intent) {
        let q = search_query_from(intent);
        return match web_search(client, &q).await {
            Ok(s) => Some((s, vec!["web_search".into()])),
            Err(e) => Some((format!("search error: {e}"), vec!["web_search".into()])),
        };
    }

    None
}

pub fn looks_like_search(intent: &str) -> bool {
    let t = intent.to_ascii_lowercase();
    if looks_like_chitchat(&t) || looks_like_identity(intent) {
        return false;
    }
    t.contains("search")
        || t.contains("look up")
        || t.contains("lookup")
        || t.contains("look it up")
        || t.contains("look this up")
        || t.contains("look that up")
        || t.contains("look for")
        || t.contains("just look")
        || t.contains("check that")
        || t.contains("check this")
        || t.contains("google")
        || t.contains("what is")
        || t.contains("what's")
        || t.contains("whats")
        // "who is X" fact lookup — but NOT "who are you"
        || (t.contains("who is") && !t.contains("who are you"))
        || t.contains("who was")
        || (t.contains("who are") && !t.contains("who are you"))
        || t.contains("when did")
        || t.contains("when was")
        || t.contains("where is")
        || t.contains("where are")
        || t.contains("how many")
        || t.contains("how much")
        || t.contains("news about")
        || t.contains("find out")
        || t.contains("find me")
        || t.contains("find ")
        || t.contains("research")
        || t.contains("tell me about")
        || t.contains("something about")
        || t.contains("info about")
        || t.contains("info on")
        || t.contains("information about")
        || t.contains("information on")
        || t.contains("capital of")
        || t.contains("weather in")
        || t.contains("define ")
        || t.contains("definition of")
        || t.contains("explain ")
        || t.starts_with("explain")
        || t.contains("wikipedia")
        || t.contains("fact about")
        || t.contains("facts about")
        // Chinese intent markers (do NOT treat 你是谁 as search)
        || intent.contains("搜索")
        || intent.contains("查一下")
        || intent.contains("查找")
        || intent.contains("帮我查")
        || intent.contains("帮我搜")
        || intent.contains("什么是")
        || intent.contains("谁是") // 谁是X
        || (intent.contains("是谁") && !intent.contains("你是谁") && !intent.contains("您是谁"))
        || intent.contains("在哪里")
        || intent.contains("多少")
        || intent.contains("首都")
        || (intent.contains("介绍一下") && !intent.contains("你自己") && !intent.contains("一下你"))
        || intent.contains("了解一下")
}

/// "Who are you?" — answer as OpenLive, never search Wikipedia.
pub fn looks_like_identity(intent: &str) -> bool {
    let raw = intent.trim();
    let t = raw.to_ascii_lowercase();
    let t = t.trim_end_matches(['?', '？', '!', '！', '.', '。']).trim();
    matches!(
        t,
        "who are you"
            | "who r you"
            | "who're you"
            | "what are you"
            | "what is your name"
            | "what's your name"
            | "whats your name"
            | "your name"
            | "introduce yourself"
            | "tell me about yourself"
    ) || t.starts_with("who are you")
        || t.starts_with("what are you")
        || matches!(
            raw.trim_end_matches(['?', '？', '!', '！', '.', '。']).trim(),
            "你是谁"
                | "您是谁"
                | "你叫什么"
                | "你叫什么名字"
                | "你是什么"
                | "你是什么东西"
                | "介绍一下你自己"
                | "介绍下你自己"
                | "你是哪个"
        )
        || raw.contains("你是谁") && raw.chars().count() <= 12
        || raw.contains("您是谁") && raw.chars().count() <= 12
}

/// Short spoken self-intro (bilingual).
pub fn identity_reply(intent: &str) -> String {
    if has_cjk(intent) {
        "我是 OpenLive，一个本地语音助手。我可以跟你聊天、上网查资料、做简单计算，也可以报时间。直接问我就行。".into()
    } else {
        "I'm OpenLive, your local voice assistant. I can chat, look things up, do simple math, and tell the time. Just ask.".into()
    }
}

/// Small talk — do not force tools.
pub fn looks_like_chitchat(intent: &str) -> bool {
    if looks_like_identity(intent) {
        return true;
    }
    let t = intent.trim().to_ascii_lowercase();
    let raw = intent.trim();
    matches!(
        t.as_str(),
        "hi" | "hello" | "hey" | "yo" | "sup" | "thanks" | "thank you" | "ok" | "okay"
            | "bye" | "goodbye" | "good morning" | "good night" | "how are you"
            | "how's it going" | "hows it going" | "what's up" | "whats up"
            | "i'm fine" | "im fine" | "cool" | "nice" | "great" | "lol" | "haha"
    ) || t.starts_with("how are you")
        || t.starts_with("nice to meet")
        || matches!(
            raw,
            "你好" | "您好" | "嗨" | "哈喽" | "谢谢" | "多谢" | "再见" | "拜拜" | "早上好"
                | "晚安" | "你好啊" | "在吗" | "嗯" | "好的" | "好" | "行"
        )
}

/// Fact-ish question that should use tools, not free-form model guessing.
pub fn looks_like_fact_query(intent: &str) -> bool {
    if looks_like_chitchat(intent) || looks_like_math(intent) || looks_like_time(intent) {
        return looks_like_search(intent);
    }
    looks_like_search(intent)
        || (!looks_like_chitchat(intent)
            && intent.trim().len() > 12
            && (intent.contains('?')
                || intent.to_ascii_lowercase().starts_with("why ")
                || intent.to_ascii_lowercase().starts_with("how does")
                || intent.to_ascii_lowercase().starts_with("how do ")
                || intent.to_ascii_lowercase().starts_with("how did")))
}

pub fn looks_like_math(intent: &str) -> bool {
    let t = intent.to_ascii_lowercase();
    t.contains("calculate")
        || t.contains("compute")
        || intent.contains("计算")
        || intent.contains("算一下")
        || (t.contains("what is") || t.contains("what's") || t.contains("whats"))
            && (t.contains('+')
                || t.contains(" plus ")
                || t.contains(" times ")
                || t.contains(" minus ")
                || t.contains(" divided "))
        || (intent.contains("加") || intent.contains("减") || intent.contains("乘") || intent.contains("除"))
            && intent.chars().any(|c| c.is_ascii_digit())
        || (t.chars().any(|c| matches!(c, '+' | '*' | '/'))
            && t.chars().any(|c| c.is_ascii_digit()))
}

pub fn looks_like_time(intent: &str) -> bool {
    let t = intent.to_ascii_lowercase();
    t.contains("what time")
        || t.contains("current time")
        || t.contains("what's the time")
        || t.contains("whats the time")
        || t.trim() == "time"
        || t.contains("what day is it")
        || t.contains("what's the date")
        || intent.contains("几点")
        || intent.contains("现在时间")
        || intent.contains("什么时间")
        || intent.contains("今天几号")
}

/// CJK Unified Ideographs (common Chinese characters).
pub fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| {
        ('\u{4e00}'..='\u{9fff}').contains(&c)
            || ('\u{3400}'..='\u{4dbf}').contains(&c)
            || ('\u{f900}'..='\u{faff}').contains(&c)
    })
}

pub fn search_query_from(intent: &str) -> String {
    // Typo-fix first so ASR noise does not kill search.
    let intent = correct_typos(intent);
    // Preserve Chinese; only lower ASCII wrappers.
    let mut q = intent;
    q = q
        .chars()
        .map(|c| {
            if c.is_ascii_alphabetic() {
                c.to_ascii_lowercase()
            } else {
                c
            }
        })
        .collect();
    q = q.replace(['?', '!', ',', '.', '？', '！', '，', '。', '、'], " ");
    q = q.split_whitespace().collect::<Vec<_>>().join(" ");

    // Strip stacked wrappers: "help me search something about Apple" → "apple"
    let prefixes = [
        "hey ",
        "hi ",
        "hello ",
        "please ",
        "can you ",
        "could you ",
        "would you ",
        "help me ",
        "i want to ",
        "i need to ",
        "i'd like to ",
        "id like to ",
        "search for ",
        "search something about ",
        "search about ",
        "search ",
        "just look it up ",
        "please just look it up ",
        "look it up ",
        "look this up ",
        "look that up ",
        "look for ",
        "look up ",
        "lookup ",
        "just look up ",
        "google ",
        "find me info on ",
        "find me info about ",
        "find me information on ",
        "find me information about ",
        "find me ",
        "find out about ",
        "find out ",
        "find info on ",
        "find info about ",
        "find information on ",
        "find information about ",
        "find ",
        // NOTE: do NOT strip bare "check " — it destroys "check gpt" (ChatGPT ASR).
        "check on ",
        "check that ",
        "check this ",
        "tell me about ",
        "tell me ",
        "something about ",
        "info about ",
        "info on ",
        "information about ",
        "information on ",
        "news about ",
        "research ",
        "explain ",
        "define ",
        "definition of ",
        "facts about ",
        "fact about ",
        "please ",
        "just ",
        "what is the ",
        "what's the ",
        "whats the ",
        "what is a ",
        "what is an ",
        "what is ",
        "what's ",
        "whats ",
        "who is ",
        "who was ",
        "who are ",
        "where is ",
        "where are ",
        "when was ",
        "when did ",
        "how many ",
        "how much ",
        // Chinese wrappers (often no spaces: 什么是苹果公司)
        "请你",
        "请",
        "帮我查一下",
        "帮我搜一下",
        "帮我查",
        "帮我搜",
        "帮我",
        "麻烦",
        "搜索一下",
        "搜索",
        "查一下",
        "查找",
        "了解一下",
        "介绍一下",
        "什么是",
        "是谁",
        "在哪里",
        "哪里是",
        "多少",
        "的首都",
        "你现在使用搜索工具来查一下",
        "使用搜索工具来查一下",
        "使用搜索工具",
        "用搜索工具",
        "来查一下",
        "查一下什么是",
        "搜索一下什么是",
        "帮我搜索一下",
        "帮我搜索",
    ];
    for _ in 0..8 {
        let before = q.clone();
        q = q.trim().to_owned();
        for p in prefixes {
            if let Some(rest) = q.strip_prefix(p) {
                q = rest.trim().trim_start_matches([' ', '，', '、', ':']).to_owned();
            }
        }
        if q == before {
            break;
        }
    }

    // "please just look it up Apple" when wrappers sit mid-phrase.
    for marker in [
        "look it up ",
        "look this up ",
        "look that up ",
        "look for ",
        "look up ",
        "search for ",
        "search ",
        "find me ",
        "find ",
        "info on ",
        "info about ",
        // never mid-strip bare "check " (breaks "check gpt")
    ] {
        if let Some(i) = q.rfind(marker) {
            let after = q[i + marker.len()..].trim();
            if after.len() >= 2 {
                q = after.to_owned();
                break;
            }
        }
    }

    // "… about Apple" leftover → take topic after last " about "
    if let Some(i) = q.rfind(" about ") {
        let after = q[i + 7..].trim();
        if after.len() >= 2 {
            q = after.to_owned();
        }
    }
    // "… on Microsoft" leftover
    if let Some(i) = q.rfind(" on ") {
        let after = q[i + 4..].trim();
        if after.len() >= 2 && after.split_whitespace().count() <= 5 {
            q = after.to_owned();
        }
    }

    // "planets are there" / "people live in japan" after "how many"
    for tail in [" are there", " is there", " were there", " was there"] {
        if let Some(rest) = q.strip_suffix(tail) {
            q = rest.trim().to_owned();
            break;
        }
    }

    // Leftover filler words from speech.
    for junk in ["me ", "some ", "any ", "more "] {
        if let Some(rest) = q.strip_prefix(junk) {
            if rest.len() >= 2 {
                q = rest.to_owned();
            }
        }
    }

    // Chinese: "法国的首都" → "法国" (then capital-of ranking can use country page)
    if let Some(place) = q.strip_suffix("的首都") {
        let place = place.trim();
        if place.chars().count() >= 1 {
            q = format!("capital of {place}");
        }
    } else if let Some(place) = q.strip_suffix("首都") {
        let place = place.trim().trim_end_matches('的');
        if place.chars().count() >= 1 {
            q = format!("capital of {place}");
        }
    }

    q = q
        .trim()
        .trim_start_matches("the ")
        .trim_start_matches("a ")
        .trim_start_matches("an ")
        .trim_matches(|c: char| matches!(c, '-' | '—' | '–' | ':' | ';'))
        .trim()
        .to_owned();
    q
}

/// True when model output is planning / CoT / meta instead of a real answer.
/// Never show this kind of text to the human.
/// Keep this STRICT — do not flag short real answers like "42" or "Paris".
pub fn is_junk_spoken(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    let trimmed = t.trim();
    if trimmed.is_empty() {
        return true;
    }
    // Explicit planning / roleplay / private-thought leaks only.
    let bad_phrases = [
        "got it, let's",
        "got it. let's",
        "got it let's",
        "let's respond",
        "let's tackle",
        "let me think about how",
        "let me respond",
        "first, the user",
        "first the user",
        "the user asked",
        "user said",
        "user wants me to",
        "wait, need to",
        "make it more natural",
        "1-2 sentences",
        "1-2 short",
        "no markdown",
        "chain of thought",
        "as an ai",
        "i need to make sure",
        "i should respond",
        "my response should",
        "my reply should",
        "planning:",
        "thinking:",
        "thought process",
        "step 1:",
        "step 2:",
        "here's how i'll",
        "here is how i'll",
        "respond warmly",
        "planning text",
        "model replied",
        "i'll use the tool",
        "i will use the tool",
        "calling the tool",
        "function call",
        "<think",
        "</think",
        "internal monologue",
        "hidden reasoning",
        "i can't actually search",
        "i cannot search",
        "i don't have access to the internet",
        "i do not have access to the internet",
        "i'm unable to browse",
        "i am unable to browse",
        "as a language model i cannot",
    ];
    for p in bad_phrases {
        if t.contains(p) {
            return true;
        }
    }
    // Multi-turn self-talk / drafting markers.
    if t.matches("wait").count() >= 2 && t.contains("let's") {
        return true;
    }
    false
}

/// Safe text for the human from a tool result (facts only).
pub fn public_tool_answer(intent: &str, raw: &str) -> String {
    if raw.starts_with("search error:") || raw.contains("no search results") {
        if has_cjk(intent) {
            return "没查到可靠结果。可以试着说更短的名字，比如 ChatGPT、苹果公司 或 法国首都。".into();
        }
        return "I couldn't find solid results. Try a short name like ChatGPT, Apple Inc., or capital of France.".into();
    }
    if let Some(direct) = direct_capital_answer(intent, raw) {
        return direct;
    }
    if let Some(direct) = direct_population_answer(intent, raw) {
        return direct;
    }
    // Speak like a person: drop "Title: " dumps, keep 1–2 sentences.
    let mut body = speakable_tool_result(raw, 360);
    if let Some(i) = body.find(": ") {
        let label = &body[..i];
        // Wikipedia style "Apple Inc.: …" — strip the label even if it has a period.
        let looks_like_title = i < 56
            && !label.contains('?')
            && !label.contains('!')
            && label.split_whitespace().count() <= 8;
        if looks_like_title {
            body = body[i + 2..].trim().to_owned();
        }
    }
    // Prefer first two sentences max for voice.
    body = speakable_tool_result(&body, 280);
    let _ = intent;
    body
}

/// Safe text for the human from a model reply. `None` if it is private thought / junk.
pub fn public_llm_answer(text: &str) -> Option<String> {
    let t = strip_thinking_for_user(text);
    if t.is_empty() || is_junk_spoken(&t) {
        return None;
    }
    Some(t)
}

/// Remove private thinking so humans never see model internals.
pub fn strip_thinking_for_user(text: &str) -> String {
    let mut t = text.to_owned();
    for (open, close) in [
        ("<think>", "</think>"),
        ("<thinking>", "</thinking>"),
        ("<reasoning>", "</reasoning>"),
        ("<reflection>", "</reflection>"),
    ] {
        while let Some(start) = t.to_ascii_lowercase().find(open) {
            let after = start + open.len();
            if let Some(rel) = t[after..].to_ascii_lowercase().find(close) {
                let end = after + rel + close.len();
                t = format!("{}{}", &t[..start], &t[end..]);
            } else {
                t = t[..start].to_owned();
                break;
            }
        }
    }
    // Drop lines that are clearly private notes.
    let kept: Vec<&str> = t
        .lines()
        .filter(|line| {
            let l = line.trim().to_ascii_lowercase();
            if l.is_empty() {
                return false;
            }
            !(l.starts_with("thought:")
                || l.starts_with("thinking:")
                || l.starts_with("reasoning:")
                || l.starts_with("plan:")
                || l.starts_with("note to self")
                || l.starts_with("internal:"))
        })
        .collect();
    let mut out = kept.join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
    // If still starts with meta scaffolding, cut after final answer markers.
    let lower = out.to_ascii_lowercase();
    for marker in ["final answer:", "answer:", "response:"] {
        if let Some(i) = lower.find(marker) {
            out = out[i + marker.len()..].trim().to_owned();
            break;
        }
    }
    out.trim().to_owned()
}

/// Last-resort fallback only. Prefer real tool results over this.
pub fn soft_no_answer() -> String {
    "I still need a clearer topic to look up. Try naming it directly, like Apple or capital of France.".into()
}

/// Clip tool text into a short speakable fact block (no LLM).
pub fn speakable_tool_result(raw: &str, max_chars: usize) -> String {
    let mut t = raw.replace('\n', " ");
    t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    // Prefer the first 1–2 full sentences when the dump is long.
    if t.len() > max_chars {
        let mut end = 0usize;
        let mut sentences = 0u8;
        for (i, c) in t.char_indices() {
            if matches!(c, '.' | '!' | '?') {
                sentences += 1;
                end = i + c.len_utf8();
                if sentences >= 2 || end >= max_chars {
                    break;
                }
            }
        }
        if end > max_chars / 4 {
            return t[..end].trim().to_owned();
        }
        let mut cut: String = t.chars().take(max_chars).collect();
        if let Some(i) = cut.rfind(['.', '!', '?']) {
            if i > max_chars / 3 {
                cut = cut[..=i].to_owned();
                return cut.trim().to_owned();
            }
        }
        if let Some(i) = cut.rfind(' ') {
            cut = cut[..i].to_owned();
        }
        return format!("{}…", cut.trim());
    }
    t
}

/// If the intent is "capital of X" and the corpus mentions it, return a short direct answer.
pub fn direct_capital_answer(intent: &str, corpus: &str) -> Option<String> {
    let cleaned = search_query_from(intent);
    let place = cleaned.strip_prefix("capital of ")?.trim();
    if place.len() < 2 {
        return None;
    }
    let city = find_capital_city(corpus)?;
    let place_nice = title_case_words(place);
    Some(format!("The capital of {place_nice} is {city}."))
}

fn find_capital_city(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let mut search_from = 0usize;
    while let Some(rel) = lower[search_from..].find("capital") {
        let start = search_from + rel;
        let end = (start + 140).min(text.len());
        let window = &text[start..end];
        let wlower = window.to_ascii_lowercase();
        for marker in [" is ", " has been ", " was "] {
            if let Some(is_rel) = wlower.find(marker) {
                let after = window[is_rel + marker.len()..].trim();
                if let Some(name) = take_proper_name(after) {
                    return Some(name);
                }
            }
        }
        search_from = start + 7;
        if search_from >= lower.len() {
            break;
        }
    }
    None
}

/// First 1–3 capitalized name tokens; stops at lowercase words ("and", "its", …).
fn take_proper_name(after: &str) -> Option<String> {
    let mut words = Vec::new();
    for w in after.split_whitespace() {
        let clean: String = w
            .chars()
            .filter(|c| c.is_alphabetic() || matches!(*c, '-' | '\''))
            .collect();
        if clean.is_empty() {
            break;
        }
        let first = clean.chars().next()?;
        if !first.is_uppercase() {
            break;
        }
        // Avoid swallowing "Berlin And Its…" if weird casing appears.
        let low = clean.to_ascii_lowercase();
        if matches!(
            low.as_str(),
            "and" | "or" | "the" | "its" | "of" | "a" | "an" | "in" | "on"
        ) {
            break;
        }
        words.push(clean);
        if words.len() >= 3 {
            break;
        }
    }
    if words.is_empty() {
        None
    } else {
        Some(words.join(" "))
    }
}

/// "population of Japan" → short spoken fact when corpus has a number.
pub fn direct_population_answer(intent: &str, corpus: &str) -> Option<String> {
    let cleaned = search_query_from(intent);
    let place = cleaned
        .strip_prefix("population of ")
        .or_else(|| {
            if cleaned.starts_with("population ") {
                Some(cleaned.trim_start_matches("population ").trim())
            } else {
                None
            }
        })?
        .trim();
    if place.len() < 2 {
        return None;
    }
    let pop = find_population_figure(corpus)?;
    let place_nice = title_case_words(place);
    Some(format!("{place_nice} has a population of about {pop}."))
}

fn find_population_figure(text: &str) -> Option<String> {
    // Normalize exotic spaces from Wikipedia extracts.
    let normalized: String = text
        .chars()
        .map(|c| {
            if c.is_whitespace() || c == '\u{00a0}' || c == '\u{202f}' || c == '\u{2009}' {
                ' '
            } else {
                c
            }
        })
        .collect();
    let lower = normalized.to_ascii_lowercase();
    let key = "population";
    let mut search_from = 0usize;
    while let Some(rel) = lower[search_from..].find(key) {
        let start = search_from + rel;
        let end = (start + 100).min(normalized.len());
        let window = &normalized[start..end];
        let wlower = window.to_ascii_lowercase();
        for marker in [" of almost ", " of over ", " of about ", " of nearly ", " of around ", " of "]
        {
            if let Some(i) = wlower.find(marker) {
                let after = window[i + marker.len()..].trim_start();
                // Number (with . or ,) then optional million/billion.
                let mut num = String::new();
                let mut rest = after;
                for (idx, ch) in after.char_indices() {
                    if ch.is_ascii_digit() || ch == '.' || ch == ',' {
                        num.push(ch);
                        rest = &after[idx + ch.len_utf8()..];
                    } else {
                        rest = &after[idx..];
                        break;
                    }
                }
                if num.is_empty() {
                    continue;
                }
                rest = rest.trim_start();
                let unit: String = rest
                    .chars()
                    .take_while(|c| c.is_alphabetic())
                    .collect::<String>()
                    .to_ascii_lowercase();
                let figure = if matches!(
                    unit.as_str(),
                    "million" | "billion" | "thousand" | "trillion"
                ) {
                    format!("{num} {unit}")
                } else {
                    num
                };
                return Some(figure);
            }
        }
        search_from = start + key.len();
        if search_from >= lower.len() {
            break;
        }
    }
    None
}

fn title_case_words(s: &str) -> String {
    s.split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn title_rank(title: &str, cleaned: &str) -> i32 {
    let tl = title.to_ascii_lowercase();
    let mut score = 0i32;
    if tl.contains("disambiguation") {
        score -= 100;
    }
    if tl.starts_with("list of ") {
        score -= 40;
    }
    if tl.contains("(film)") || tl.contains("(album)") || tl.contains("(song)") {
        score -= 30;
    }
    // Token overlap: "population of japan" must beat "population of jamaica".
    let tokens: Vec<&str> = cleaned
        .split_whitespace()
        .filter(|w| w.len() > 2 && !matches!(*w, "the" | "and" | "for" | "are" | "was"))
        .collect();
    for w in &tokens {
        if tl.contains(w) {
            score += 25;
        } else {
            score -= 35;
        }
    }
    if let Some(place) = cleaned.strip_prefix("capital of ") {
        let place = place.trim();
        if tl == place {
            score += 90;
        }
        if tl == format!("capital of {place}") {
            score += 50;
        }
        if tl.starts_with("list of capitals") {
            score -= 15;
        }
    }
    if let Some(place) = cleaned.strip_prefix("population of ") {
        let place = place.trim();
        if tl == place {
            score += 100; // country page has the population figure
        }
        if tl == format!("population of {place}") || tl == format!("demographics of {place}") {
            score += 70;
        }
    }
    if cleaned.contains("moon landing") && (tl.contains("apollo 11") || tl.contains("apollo11")) {
        score += 80;
    }
    // Prefer brand company pages when query is bare brand.
    if cleaned == "apple" && tl.contains("inc") {
        score += 80;
    }
    // "check gpt" / "chatgpt" must rank ChatGPT over chess Checkmate.
    if cleaned.contains("gpt") || cleaned.contains("chatgpt") || cleaned.contains("check gpt") {
        if tl.contains("chatgpt") {
            score += 200;
        }
        if tl.contains("gpt-4") || tl.contains("gpt-3") || tl == "gpt" {
            score += 80;
        }
        if tl.contains("openai") {
            score += 40;
        }
        if tl.contains("checkmate") || tl == "check" || tl.starts_with("check (") {
            score -= 150;
        }
    }
    // "agent" queries → AI/software agent, not insurance "agent" pages only.
    if cleaned.contains("agent") {
        if tl.contains("intelligent agent") || tl.contains("software agent") {
            score += 180;
        }
        if tl.contains("artificial intelligence") || tl.contains("multi-agent") {
            score += 60;
        }
        if tl.contains("secret agent") || tl.contains("sports agent") || tl.contains("real estate") {
            score -= 80;
        }
    }
    if tl == cleaned {
        score += 20;
    }
    // Alias exact titles
    for a in expand_search_aliases(cleaned) {
        if tl == a.to_ascii_lowercase() {
            score += 250;
        }
    }
    score
}

pub fn extract_math_expr(intent: &str) -> Option<String> {
    // Prefer digit/operator spans; also map words.
    let mut s = intent.to_ascii_lowercase();
    s = s
        .replace("plus", "+")
        .replace("minus", "-")
        .replace("times", "*")
        .replace("multiplied by", "*")
        .replace("divided by", "/");
    let mut expr = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() || matches!(c, '+' | '-' | '*' | '/' | '(' | ')' | '.' | ' ') {
            expr.push(c);
        } else if !expr.trim().is_empty()
            && expr.chars().any(|x| x.is_ascii_digit())
            && expr.chars().any(|x| matches!(x, '+' | '-' | '*' | '/'))
            && c.is_ascii_alphabetic()
        {
            break;
        }
    }
    let e: String = expr.chars().filter(|c| !c.is_whitespace()).collect();
    if e.chars().any(|c| c.is_ascii_digit()) && e.chars().any(|c| matches!(c, '+' | '-' | '*' | '/'))
    {
        Some(e)
    } else {
        None
    }
}

/// Map speech/common mishears to Wikipedia titles (e.g. "check gpt" → ChatGPT).
pub fn expand_search_aliases(cleaned: &str) -> Vec<String> {
    let c = cleaned
        .to_ascii_lowercase()
        .replace(['-', '_'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = Vec::new();
    let aliases: &[(&str, &str)] = &[
        // ASR often hears ChatGPT as "check gpt"
        ("check gpt", "ChatGPT"),
        ("checkgpt", "ChatGPT"),
        ("chat gpt", "ChatGPT"),
        ("chatgpt", "ChatGPT"),
        ("chat g p t", "ChatGPT"),
        ("gpt chat", "ChatGPT"),
        ("open ai", "OpenAI"),
        ("openai", "OpenAI"),
        ("gpt 4", "GPT-4"),
        ("gpt4", "GPT-4"),
        ("gpt 3", "GPT-3"),
        ("gpt3", "GPT-3"),
        ("claude ai", "Claude (language model)"),
        ("gemini ai", "Google Gemini"),
        ("ai detector", "AI detector"),
        ("check ai", "AI detector"),
        ("ai checker", "AI detector"),
        // "what is agent" / software agent
        ("ai agent", "Intelligent agent"),
        ("an ai agent", "Intelligent agent"),
        ("software agent", "Software agent"),
        ("an agent", "Intelligent agent"),
        ("agent", "Intelligent agent"),
    ];
    for (from, to) in aliases {
        // Exact or whole-phrase contains only (avoid "gpt" eating longer queries wrongly).
        if c == *from || c == from.replace(' ', "") {
            out.push((*to).to_owned());
            continue;
        }
        // Phrase boundary contains: "what about check gpt please"
        if from.len() >= 5 && (c.contains(&format!(" {from} ")) || c.starts_with(&format!("{from} ")) || c.ends_with(&format!(" {from}"))) {
            out.push((*to).to_owned());
        }
    }
    // Bare "gpt" alone is ambiguous — prefer ChatGPT as default product.
    if c == "gpt" {
        out.push("ChatGPT".into());
    }
    // Spaced letters: "c h a t g p t"
    if c.replace(' ', "") == "chatgpt" || c.replace(' ', "") == "checkgpt" {
        out.push("ChatGPT".into());
    }
    // Dedupe while preserving order.
    let mut seen = std::collections::HashSet::new();
    out.retain(|x| seen.insert(x.to_ascii_lowercase()));
    out
}

pub async fn web_search(client: &Client, query: &str) -> Result<String, String> {
    Ok(web_search_with_sources(client, query).await?.0)
}

/// Search plus structured citations for UI cards / memory pinning.
pub async fn web_search_with_sources(
    client: &Client,
    query: &str,
) -> Result<(String, Vec<Citation>), String> {
    let mut parts = Vec::new();
    let mut sources: Vec<Citation> = Vec::new();
    let ua = "OpenLive/26.7.15 (https://github.com/openlive; agent-search)";
    let cleaned = search_query_from(query);
    if cleaned.is_empty() {
        return Err("empty search query".into());
    }
    let aliases = expand_search_aliases(&cleaned);
    // Chinese-only queries → zh wiki; mixed "什么是 ChatGPT" with English topic → en wiki first.
    let wiki_host = if has_cjk(&cleaned) && !cleaned.chars().any(|c| c.is_ascii_alphabetic()) {
        "zh.wikipedia.org"
    } else if has_cjk(query) && aliases.iter().any(|a| a.contains("ChatGPT") || a.contains("GPT")) {
        "en.wikipedia.org"
    } else if has_cjk(&cleaned) || (has_cjk(query) && !cleaned.chars().any(|c| c.is_ascii_alphabetic())) {
        "zh.wikipedia.org"
    } else {
        "en.wikipedia.org"
    };

    // Alias pages first and exclusive: "check gpt" → ChatGPT (not chess / GPT-4 noise).
    for a in &aliases {
        if let Some((label, extract, url)) = wiki_summary(client, ua, "en.wikipedia.org", a).await {
            if !extract.is_empty() {
                let joined = format!("{label}: {extract}");
                sources.push(Citation {
                    title: label,
                    url,
                    snippet: extract.chars().take(160).collect(),
                });
                return Ok((speakable_tool_result(&joined, 420), sources));
            }
        }
        // Chinese Wikipedia alias page if present.
        if wiki_host.starts_with("zh.") {
            if let Some((label, extract, url)) = wiki_summary(client, ua, wiki_host, a).await {
                if !extract.is_empty() {
                    let joined = format!("{label}: {extract}");
                    sources.push(Citation {
                        title: label,
                        url,
                        snippet: extract.chars().take(160).collect(),
                    });
                    return Ok((speakable_tool_result(&joined, 420), sources));
                }
            }
        }
    }

    // Build search variants that Wikipedia understands.
    let mut searches: Vec<String> = Vec::new();
    for a in &aliases {
        searches.push(a.clone());
    }

    // "capital of France" / "capital of 法国" → country page first.
    if let Some(place) = cleaned.strip_prefix("capital of ") {
        let place = place.trim();
        if !place.is_empty() {
            if has_cjk(place) {
                searches.push(place.to_owned());
            } else {
                searches.push(title_case_words(place));
                searches.push(place.to_owned());
                searches.push(format!("Capital of {}", title_case_words(place)));
            }
        }
    }
    // "population of Japan" → country page first (has the figure).
    if let Some(place) = cleaned.strip_prefix("population of ") {
        let place = place.trim();
        if place.len() >= 2 {
            searches.push(title_case_words(place));
            searches.push(format!("Demographics of {}", title_case_words(place)));
            searches.push(format!("Population of {}", title_case_words(place)));
        }
    }
    if cleaned.contains("moon landing") {
        searches.push("Apollo 11".into());
        searches.push("Moon landing".into());
    }
    // Title-case first — direct summary hits (Bitcoin, Tokyo) without opensearch.
    searches.push(title_case_words(&cleaned));
    searches.push(cleaned.clone());

    // Common tech/brand: bare "apple" often means the company in search intents.
    let brand_boosts = [
        ("apple", "Apple Inc."),
        ("google", "Google"),
        ("microsoft", "Microsoft"),
        ("amazon", "Amazon (company)"),
        ("meta", "Meta Platforms"),
        ("tesla", "Tesla, Inc."),
        ("nvidia", "Nvidia"),
        ("openai", "OpenAI"),
        ("chatgpt", "ChatGPT"),
        ("bitcoin", "Bitcoin"),
        ("ethereum", "Ethereum"),
    ];
    for (bare, title) in brand_boosts {
        let cl = cleaned.to_ascii_lowercase().replace(' ', "");
        if cleaned == bare
            || cl == bare
            || cleaned == format!("{bare} company")
            || cleaned == format!("{bare} inc")
        {
            searches.insert(0, title.to_owned());
            break;
        }
    }
    // "how many planets" → also try Planet / Solar System
    if cleaned == "planets" || cleaned.contains("planet") {
        searches.insert(0, "Planet".into());
        searches.push("Solar System".into());
    }

    let mut titles: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for s in &searches {
        if s.is_empty() {
            continue;
        }
        // Seed candidate list with search strings themselves (title-case pages).
        if seen.insert(s.to_ascii_lowercase()) {
            titles.push(s.clone());
        }
        match wiki_opensearch(client, ua, wiki_host, s).await {
            Ok(found) => {
                for name in found {
                    if !name.is_empty() && seen.insert(name.to_ascii_lowercase()) {
                        titles.push(name);
                    }
                }
            }
            Err(_) => {
                // Rate-limit / transient — still try direct summaries below.
            }
        }
        if titles.len() >= 8 {
            break;
        }
    }

    // Prefer summary pages for discovered titles, then cleaned query itself.
    let mut candidates = titles;
    // Seed exact targets (country page, brand page) even if open-search order is noisy.
    if let Some(place) = cleaned.strip_prefix("capital of ") {
        let place = place.trim();
        if place.len() >= 2 {
            candidates.insert(0, title_case_words(place));
        }
    }
    for (bare, title) in brand_boosts {
        if cleaned.eq_ignore_ascii_case(bare) {
            candidates.insert(0, title.to_owned());
            break;
        }
    }
    for a in &aliases {
        candidates.insert(0, a.clone());
    }
    candidates.insert(0, title_case_words(&cleaned));
    if !cleaned.is_empty() {
        candidates.push(cleaned.clone());
    }
    // Dedup while ranking best titles first.
    let mut ranked: Vec<(i32, String)> = Vec::new();
    let mut seen_c = std::collections::HashSet::new();
    for c in candidates {
        let key = c.to_ascii_lowercase();
        if seen_c.insert(key) {
            ranked.push((title_rank(&c, &cleaned), c));
        }
    }
    ranked.sort_by(|a, b| b.0.cmp(&a.0));
    let candidates: Vec<String> = ranked.into_iter().map(|(_, t)| t).collect();

    for title in candidates.into_iter().take(8) {
        if let Some((label, extract, url)) = wiki_summary(client, ua, wiki_host, &title).await {
            if !extract.is_empty() {
                // Reject irrelevant open-search noise (e.g. Checkmate for "check gpt").
                if !title_relevant_enough(&cleaned, &label, &extract) && aliases.is_empty() {
                    continue;
                }
                if !aliases.is_empty()
                    && !title_relevant_enough(&cleaned, &label, &extract)
                    && !aliases.iter().any(|a| {
                        label.to_ascii_lowercase().contains(&a.to_ascii_lowercase())
                            || extract
                                .to_ascii_lowercase()
                                .contains(&a.to_ascii_lowercase())
                    })
                {
                    // Still accept if the page is an exact alias target.
                    let ok_alias = aliases.iter().any(|a| label.eq_ignore_ascii_case(a));
                    if !ok_alias {
                        continue;
                    }
                }
                parts.push(format!("{label}: {extract}"));
                sources.push(Citation {
                    title: label.clone(),
                    url,
                    snippet: extract.chars().take(160).collect(),
                });
                if cleaned.starts_with("capital of ") && find_capital_city(&extract).is_some() {
                    break;
                }
                if parts.len() >= 2 {
                    break;
                }
            }
        }
    }

    // DuckDuckGo Instant Answer fallback (works when Wikipedia has no page).
    if parts.is_empty() {
        if let Some((ddg, cite)) = ddg_instant_answer(client, ua, &cleaned).await {
            parts.push(ddg);
            sources.push(cite);
        }
        for a in &aliases {
            if let Some((ddg, cite)) = ddg_instant_answer(client, ua, a).await {
                parts.push(ddg);
                sources.push(cite);
                break;
            }
        }
    }

    // If Chinese query found nothing on zh wiki, try English once.
    if parts.is_empty() && wiki_host.starts_with("zh.") {
        if let Ok((en, mut en_src)) = Box::pin(web_search_en_only(client, &cleaned)).await {
            sources.append(&mut en_src);
            return Ok((en, sources));
        }
    }
    // Alias English pages if still empty.
    if parts.is_empty() {
        for a in &aliases {
            if let Some((label, extract, url)) =
                wiki_summary(client, ua, "en.wikipedia.org", a).await
            {
                if !extract.is_empty() {
                    parts.push(format!("{label}: {extract}"));
                    sources.push(Citation {
                        title: label,
                        url,
                        snippet: extract.chars().take(160).collect(),
                    });
                    break;
                }
            }
        }
    }

    if parts.is_empty() {
        Err(format!(
            "no search results for '{query}' (try a shorter name like ChatGPT or Apple Inc.)"
        ))
    } else {
        let joined = parts.join("\n\n");
        if let Some(direct) = direct_capital_answer(query, &joined) {
            return Ok((direct, sources));
        }
        Ok((joined, sources))
    }
}

/// Loose relevance: query tokens should appear in title or extract (skip stopwords).
fn title_relevant_enough(cleaned: &str, title: &str, extract: &str) -> bool {
    let stop = ["the", "a", "an", "of", "for", "and", "is", "what", "who"];
    let hay = format!("{} {}", title, extract).to_ascii_lowercase();
    let tokens: Vec<&str> = cleaned
        .split_whitespace()
        .filter(|t| t.len() > 2 && !stop.contains(t))
        .collect();
    if tokens.is_empty() {
        return true;
    }
    // Special: check+gpt queries should hit chatgpt/gpt pages, not chess "check".
    let cl = cleaned.to_ascii_lowercase();
    if cl.contains("gpt") {
        if hay.contains("chatgpt") || hay.contains("gpt-") || hay.contains("openai") {
            return true;
        }
        if hay.contains("checkmate") || hay.contains("chess") {
            return false;
        }
    }
    let hits = tokens
        .iter()
        .filter(|t| hay.contains(&t.to_ascii_lowercase()))
        .count();
    hits * 2 >= tokens.len() // at least half the content words
}

async fn ddg_instant_answer(client: &Client, ua: &str, q: &str) -> Option<(String, Citation)> {
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
        urlencoding_lite(q)
    );
    let resp = client
        .get(&url)
        .header("User-Agent", ua)
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: Value = resp.json().await.ok()?;
    let abstract_text = v
        .get("AbstractText")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let heading = v.get("Heading").and_then(Value::as_str).unwrap_or(q).trim();
    let abs_url = v
        .get("AbstractURL")
        .and_then(Value::as_str)
        .unwrap_or("https://duckduckgo.com")
        .to_owned();
    if abstract_text.len() > 40 {
        let text = format!("{heading}: {abstract_text}");
        return Some((
            text.clone(),
            Citation {
                title: heading.to_owned(),
                url: abs_url,
                snippet: abstract_text.chars().take(160).collect(),
            },
        ));
    }
    // RelatedTopics sometimes has text.
    if let Some(arr) = v.get("RelatedTopics").and_then(Value::as_array) {
        for item in arr.iter().take(3) {
            if let Some(text) = item.get("Text").and_then(Value::as_str) {
                if text.len() > 40 {
                    let first = text.chars().take(160).collect::<String>();
                    return Some((
                        text.to_owned(),
                        Citation {
                            title: heading.to_owned(),
                            url: abs_url,
                            snippet: first,
                        },
                    ));
                }
            }
        }
    }
    None
}

/// English-only path used as fallback after Chinese Wikipedia misses.
async fn web_search_en_only(
    client: &Client,
    cleaned: &str,
) -> Result<(String, Vec<Citation>), String> {
    let ua = "OpenLive/26.7.15 (https://github.com/openlive; agent-search)";
    let host = "en.wikipedia.org";
    let mut titles = vec![title_case_words(cleaned), cleaned.to_owned()];
    if let Ok(found) = wiki_opensearch(client, ua, host, cleaned).await {
        titles.extend(found);
    }
    for title in titles.into_iter().take(6) {
        if let Some((label, extract, url)) = wiki_summary(client, ua, host, &title).await {
            if !extract.is_empty() {
                return Ok((
                    format!("{label}: {extract}"),
                    vec![Citation {
                        title: label,
                        url,
                        snippet: extract.chars().take(160).collect(),
                    }],
                ));
            }
        }
    }
    Err("en fallback empty".into())
}

async fn wiki_opensearch(
    client: &Client,
    ua: &str,
    host: &str,
    s: &str,
) -> Result<Vec<String>, String> {
    let wiki = format!(
        "https://{host}/w/api.php?action=opensearch&search={}&limit=5&namespace=0&format=json",
        urlencoding_lite(s)
    );
    for attempt in 0..2u8 {
        let resp = client
            .get(&wiki)
            .header("User-Agent", ua)
            .header("Accept", "application/json")
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if status.as_u16() == 429 && attempt == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            continue;
        }
        if !status.is_success() {
            return Err(format!("opensearch {status}"));
        }
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        if let Some(arr) = v.get(1).and_then(Value::as_array) {
            for t in arr.iter().take(5) {
                if let Some(name) = t.as_str() {
                    if !name.is_empty() {
                        out.push(name.to_owned());
                    }
                }
            }
        }
        return Ok(out);
    }
    Err("opensearch failed".into())
}

/// Returns (title, extract, page_url).
async fn wiki_summary(
    client: &Client,
    ua: &str,
    host: &str,
    title: &str,
) -> Option<(String, String, String)> {
    let path = title.replace(' ', "_");
    let path_enc: String = path
        .chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '_' | '-' | '.' | '~' => c.to_string(),
            _ => {
                let mut buf = [0u8; 4];
                let enc = c.encode_utf8(&mut buf);
                enc.bytes()
                    .map(|b| format!("%{b:02X}"))
                    .collect::<String>()
            }
        })
        .collect();
    let sum = format!("https://{host}/api/rest_v1/page/summary/{path_enc}");
    for attempt in 0..2u8 {
        let resp = client
            .get(&sum)
            .header("User-Agent", ua)
            .header("Accept", "application/json")
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .ok()?;
        let status = resp.status();
        if status.as_u16() == 429 && attempt == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            continue;
        }
        if !status.is_success() {
            return None;
        }
        let v: Value = resp.json().await.ok()?;
        // Skip disambiguation / empty pages.
        let dtype = v.get("type").and_then(Value::as_str).unwrap_or("");
        if dtype == "disambiguation" {
            return None;
        }
        let extract = v.get("extract").and_then(Value::as_str).unwrap_or("").to_owned();
        let label = v
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(title)
            .to_owned();
        if extract.is_empty() {
            return None;
        }
        let page_url = v
            .pointer("/content_urls/desktop/page")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("https://{host}/wiki/{path_enc}"));
        return Some((label, extract, page_url));
    }
    None
}

/// Browse engine preference for sandbox browser tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowseEngine {
    /// HTTP first; if text is thin and headless is available, retry headless.
    Auto,
    /// Plain HTTP(S) fetch only.
    Http,
    /// System Chrome/Edge `--dump-dom` only.
    Headless,
}

impl BrowseEngine {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "http" | "fetch" => Self::Http,
            "headless" | "chrome" | "chromium" | "edge" => Self::Headless,
            _ => Self::Auto,
        }
    }
}

/// Fetch a public http(s) page and extract plain text (sandbox browser foundation).
/// Blocks private/link-local hosts (basic SSRF guard).
pub async fn browse_url(client: &Client, url: &str) -> Result<(String, Citation), String> {
    browse_url_with_engine(client, url, BrowseEngine::Auto)
        .await
        .map(|(t, c, _)| (t, c))
}

pub async fn browse_url_with_engine(
    client: &Client,
    url: &str,
    engine: BrowseEngine,
) -> Result<(String, Citation, String), String> {
    match engine {
        BrowseEngine::Http => browse_url_http(client, url).await,
        BrowseEngine::Headless => {
            // Run blocking Chrome CLI off the async worker.
            let url = url.to_owned();
            tokio::task::spawn_blocking(move || crate::headless_browser::headless_browse(&url))
                .await
                .map_err(|e| format!("headless task: {e}"))?
        }
        BrowseEngine::Auto => {
            // Wikipedia REST stays on HTTP path.
            if let Ok(http) = browse_url_http(client, url).await {
                let thin = http.0.chars().count() < 280;
                if thin && crate::headless_browser::find_browser_binary().is_some() {
                    let url = url.to_owned();
                    if let Ok(h) = tokio::task::spawn_blocking(move || {
                        crate::headless_browser::headless_browse(&url)
                    })
                    .await
                    .unwrap_or(Err("join".into()))
                    {
                        if h.0.chars().count() > http.0.chars().count() {
                            return Ok(h);
                        }
                    }
                }
                return Ok(http);
            }
            // HTTP failed — try headless if available.
            if crate::headless_browser::find_browser_binary().is_some() {
                let url = url.to_owned();
                return tokio::task::spawn_blocking(move || {
                    crate::headless_browser::headless_browse(&url)
                })
                .await
                .map_err(|e| format!("headless task: {e}"))?;
            }
            browse_url_http(client, url).await
        }
    }
}

/// Like `browse_url` but also returns raw HTML (truncated) for link extraction.
pub async fn browse_url_raw(
    client: &Client,
    url: &str,
) -> Result<(String, Citation, String), String> {
    browse_url_with_engine(client, url, BrowseEngine::Auto).await
}

async fn browse_url_http(
    client: &Client,
    url: &str,
) -> Result<(String, Citation, String), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("url is required".into());
    }
    // Wikipedia: prefer REST summary (clean text, small payload).
    if let Some(wiki) = try_wikipedia_summary_browse(client, url).await {
        return Ok(wiki);
    }
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("only http/https URLs are allowed".into());
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if host.is_empty() {
        return Err("url missing host".into());
    }
    if is_blocked_browse_host(&host) {
        return Err("host is blocked (private/local networks not allowed)".into());
    }
    let ua = "OpenLive/26.7.15 (sandbox-browser; +https://github.com/openlive)";
    let resp = client
        .get(parsed.clone())
        .header("User-Agent", ua)
        .header("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5")
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let final_url = resp.url().to_string();
    // Re-check host after redirects.
    if let Some(h) = resp.url().host_str() {
        if is_blocked_browse_host(&h.to_ascii_lowercase()) {
            return Err("redirected to blocked host".into());
        }
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read body: {e}"))?;
    // Truncate oversized HTML instead of failing (Wikipedia pages are often large).
    const MAX_BYTES: usize = 512 * 1024;
    let slice = if bytes.len() > MAX_BYTES {
        &bytes[..MAX_BYTES]
    } else {
        &bytes[..]
    };
    let raw = String::from_utf8_lossy(slice).into_owned();
    let text = html_to_plain(&raw);
    if text.len() < 20 {
        return Err("page had no readable text".into());
    }
    let title = extract_html_title(&raw).unwrap_or_else(|| host.clone());
    let snippet: String = text.chars().take(220).collect();
    let body: String = text.chars().take(1800).collect();
    Ok((
        format!("{title}\n\n{body}"),
        Citation {
            title,
            url: final_url,
            snippet,
        },
        raw,
    ))
}

/// Multi-page sandbox browser: open a URL, then follow up to `max_links` same-host links.
pub async fn browse_site(
    client: &Client,
    url: &str,
    max_links: usize,
) -> Result<(String, Vec<Citation>), String> {
    let max_links = max_links.clamp(0, 5);
    let (root_text, root_cite, html) = browse_url_raw(client, url).await?;
    let mut sources = vec![root_cite.clone()];
    let mut parts = vec![format!("[page 1] {}", root_text)];

    let base = reqwest::Url::parse(&root_cite.url).map_err(|e| e.to_string())?;
    let host = base.host_str().unwrap_or("").to_ascii_lowercase();
    let links = extract_same_host_links(&html, &base, &host, max_links + 4);
    for (i, link) in links.into_iter().take(max_links).enumerate() {
        match browse_url(client, &link).await {
            Ok((text, cite)) => {
                if sources.iter().any(|s| s.url == cite.url) {
                    continue;
                }
                sources.push(cite);
                parts.push(format!("[page {}] {}", i + 2, text.chars().take(900).collect::<String>()));
            }
            Err(_) => continue,
        }
    }
    Ok((parts.join("\n\n---\n\n"), sources))
}

/// Extract up to `limit` absolute same-host http(s) links from HTML.
pub fn extract_same_host_links(
    html: &str,
    base: &reqwest::Url,
    host: &str,
    limit: usize,
) -> Vec<String> {
    let mut out = Vec::new();
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    while i < lower.len() && out.len() < limit {
        let Some(rel) = lower[i..].find("href=") else {
            break;
        };
        let start = i + rel + 5;
        let bytes = html.as_bytes();
        if start >= bytes.len() {
            break;
        }
        let quote = bytes[start] as char;
        let (href, next) = if quote == '"' || quote == '\'' {
            let rest = &html[start + 1..];
            if let Some(end) = rest.find(quote) {
                (rest[..end].to_owned(), start + 1 + end + 1)
            } else {
                i = start + 1;
                continue;
            }
        } else {
            // unquoted
            let rest = &html[start..];
            let end = rest
                .find(|c: char| c.is_whitespace() || c == '>')
                .unwrap_or(rest.len().min(200));
            (rest[..end].to_owned(), start + end)
        };
        i = next;
        let href = href.trim();
        if href.is_empty()
            || href.starts_with('#')
            || href.starts_with("javascript:")
            || href.starts_with("mailto:")
            || href.starts_with("data:")
        {
            continue;
        }
        let Ok(joined) = base.join(href) else {
            continue;
        };
        if joined.scheme() != "http" && joined.scheme() != "https" {
            continue;
        }
        let h = joined.host_str().unwrap_or("").to_ascii_lowercase();
        if h != host || is_blocked_browse_host(&h) {
            continue;
        }
        let s = joined.to_string();
        if out.iter().any(|x| x == &s) {
            continue;
        }
        out.push(s);
    }
    out
}

async fn try_wikipedia_summary_browse(
    client: &Client,
    url: &str,
) -> Option<(String, Citation, String)> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if !host.ends_with("wikipedia.org") {
        return None;
    }
    let path = parsed.path(); // /wiki/Title
    let title = path.strip_prefix("/wiki/")?.replace('_', " ");
    if title.is_empty() {
        return None;
    }
    let (label, extract, page_url) = wiki_summary(client, "OpenLive/26.7.15", &host, &title).await?;
    let text = format!("{label}\n\n{extract}");
    let cite = Citation {
        title: label,
        url: page_url,
        snippet: extract.chars().take(160).collect(),
    };
    Some((text, cite, String::new()))
}

/// Save a research note into the sandbox lab folder.
pub fn save_lab_note(name: &str, content: &str) -> Result<String, String> {
    let name = name.trim().trim_start_matches(['/', '\\']);
    if name.is_empty() {
        return Err("note name required".into());
    }
    if name.contains("..") {
        return Err("invalid note name".into());
    }
    let safe = if name.ends_with(".md") || name.ends_with(".txt") {
        name.to_owned()
    } else {
        format!("{name}.md")
    };
    // lab notes live under workspace/lab/ for path safety via sandbox resolve.
    let rel = format!("lab/{safe}");
    crate::sandbox::write_file(&rel, content)
}

pub fn is_blocked_browse_host_public(host: &str) -> bool {
    is_blocked_browse_host(host)
}

fn is_blocked_browse_host(host: &str) -> bool {
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "0.0.0.0"
        || host == "[::1]"
        || host == "::1"
        || host == "metadata.google.internal"
    {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => {
                v4.is_private()
                    || v4.is_loopback()
                    || v4.is_link_local()
                    || v4.is_broadcast()
                    || v4.octets()[0] == 169 && v4.octets()[1] == 254
            }
            IpAddr::V6(v6) => v6.is_loopback() || v6.is_unique_local() || v6.is_unicast_link_local(),
        };
    }
    false
}

pub fn extract_html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let after = &html[start..];
    let gt = after.find('>')?;
    let rest = &after[gt + 1..];
    let end_rel = rest.to_ascii_lowercase().find("</title>")?;
    let t = rest[..end_rel].trim();
    if t.is_empty() {
        None
    } else {
        Some(html_entity_basic(t).chars().take(120).collect())
    }
}

pub fn html_to_plain_public(html: &str) -> String {
    html_to_plain(html)
}

fn html_to_plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 4);
    let mut in_tag = false;
    let mut in_script = false;
    let bytes = html.as_bytes();
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    while i < bytes.len() {
        if !in_tag && lower[i..].starts_with("<script") {
            in_script = true;
        }
        if in_script && lower[i..].starts_with("</script") {
            in_script = false;
        }
        if !in_tag && lower[i..].starts_with("<style") {
            in_script = true; // reuse flag for style skip
        }
        if in_script && lower[i..].starts_with("</style") {
            in_script = false;
        }
        let c = html[i..].chars().next().unwrap_or(' ');
        let clen = c.len_utf8();
        if c == '<' {
            in_tag = true;
            i += clen;
            continue;
        }
        if c == '>' {
            in_tag = false;
            i += clen;
            continue;
        }
        if !in_tag && !in_script {
            if c.is_whitespace() {
                if !out.ends_with(' ') && !out.is_empty() {
                    out.push(' ');
                }
            } else {
                out.push(c);
            }
        }
        i += clen;
    }
    html_entity_basic(out.trim())
}

fn html_entity_basic(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

pub fn simple_eval(expr: &str) -> Result<f64, String> {
    let tokens: Vec<char> = expr.chars().filter(|c| !c.is_whitespace()).collect();
    if tokens.is_empty() {
        return Err("empty".into());
    }
    let mut i = 0;
    fn parse_expr(tokens: &[char], i: &mut usize) -> Result<f64, String> {
        let mut v = parse_term(tokens, i)?;
        while *i < tokens.len() {
            match tokens[*i] {
                '+' => {
                    *i += 1;
                    v += parse_term(tokens, i)?;
                }
                '-' => {
                    *i += 1;
                    v -= parse_term(tokens, i)?;
                }
                _ => break,
            }
        }
        Ok(v)
    }
    fn parse_term(tokens: &[char], i: &mut usize) -> Result<f64, String> {
        let mut v = parse_factor(tokens, i)?;
        while *i < tokens.len() {
            match tokens[*i] {
                '*' => {
                    *i += 1;
                    v *= parse_factor(tokens, i)?;
                }
                '/' => {
                    *i += 1;
                    let d = parse_factor(tokens, i)?;
                    if d == 0.0 {
                        return Err("division by zero".into());
                    }
                    v /= d;
                }
                _ => break,
            }
        }
        Ok(v)
    }
    fn parse_factor(tokens: &[char], i: &mut usize) -> Result<f64, String> {
        if *i >= tokens.len() {
            return Err("unexpected end".into());
        }
        if tokens[*i] == '(' {
            *i += 1;
            let v = parse_expr(tokens, i)?;
            if *i >= tokens.len() || tokens[*i] != ')' {
                return Err("missing )".into());
            }
            *i += 1;
            return Ok(v);
        }
        if tokens[*i] == '-' {
            *i += 1;
            return Ok(-parse_factor(tokens, i)?);
        }
        let start = *i;
        while *i < tokens.len() && (tokens[*i].is_ascii_digit() || tokens[*i] == '.') {
            *i += 1;
        }
        if start == *i {
            return Err(format!("bad token near {}", tokens[*i]));
        }
        let s: String = tokens[start..*i].iter().collect();
        s.parse::<f64>().map_err(|_| format!("bad number {s}"))
    }
    let v = parse_expr(&tokens, &mut i)?;
    if i != tokens.len() {
        return Err("trailing junk".into());
    }
    Ok(v)
}

fn chrono_lite_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let tod = secs % 86_400;
    let h = tod / 3600;
    let m = (tod % 3600) / 60;
    // Spoken-friendly UTC clock (no raw unix id).
    format!("It's about {h:02}:{m:02} UTC right now.")
}

fn urlencoding_lite(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calc_and_routing() {
        assert!((simple_eval("12+30").unwrap() - 42.0).abs() < 1e-9);
        assert!(looks_like_search("what is the capital of France"));
        assert!(looks_like_search("help me search something about Apple"));
        assert!(looks_like_math("what is 12 + 30"));
        assert!(extract_math_expr("what is 12 + 30").is_some());
        assert_eq!(
            search_query_from("what is the capital of France"),
            "capital of france"
        );
        assert_eq!(
            search_query_from("help me search something about Apple"),
            "apple"
        );
        assert_eq!(search_query_from("search something about Apple"), "apple");
        assert_eq!(
            search_query_from("please just look it up — Apple"),
            "apple"
        );
        assert_eq!(search_query_from("look it up Apple"), "apple");
        assert_eq!(
            search_query_from("find me info on Microsoft"),
            "microsoft"
        );
        assert_eq!(search_query_from("look for OpenAI"), "openai");
        assert_eq!(
            search_query_from("how many planets are there"),
            "planets"
        );
        assert_eq!(search_query_from("where is Tokyo"), "tokyo");
        assert_eq!(search_query_from("what is Bitcoin"), "bitcoin");
        assert!(looks_like_search("find me info on Microsoft"));
        assert!(looks_like_search("look for OpenAI"));
        assert!(looks_like_search("什么是苹果公司"));
        assert!(has_cjk("苹果公司"));
        assert_eq!(search_query_from("什么是苹果公司"), "苹果公司");
        assert_eq!(search_query_from("帮我查一下微软"), "微软");
        // Typo layer rewrites "check gpt" → ChatGPT before query clean.
        assert!(
            search_query_from("what is check gpt")
                .to_ascii_lowercase()
                .contains("chatgpt")
                || search_query_from("what is check gpt") == "check gpt"
        );
        assert!(expand_search_aliases("check gpt").contains(&"ChatGPT".to_string()));
        assert_eq!(expand_search_aliases("check gpt").len(), 1);
        assert!(
            search_query_from("search what is agent")
                .to_ascii_lowercase()
                .contains("agent")
        );
        assert!(looks_like_identity("你是谁"));
        assert!(looks_like_identity("who are you"));
        assert!(!looks_like_search("你是谁"));
        assert!(identity_reply("你是谁").contains("OpenLive"));
        assert!(expand_search_aliases("chat gpt").contains(&"ChatGPT".to_string()));
        assert!(title_rank("ChatGPT", "check gpt") > title_rank("Checkmate", "check gpt"));
        assert!(is_junk_spoken(
            "Got it, let's respond warmly and naturally. First, greet back..."
        ));
        assert!(is_junk_spoken("I can't actually search the web."));
        assert!(!is_junk_spoken(
            "Apple Inc. is an American multinational technology company."
        ));
        assert!(!is_junk_spoken("42"));
        assert!(!is_junk_spoken("Paris."));
        assert_eq!(
            public_llm_answer("<think>plan the reply</think>Paris is the capital."),
            Some("Paris is the capital.".into())
        );
        assert!(public_llm_answer("Got it, let's respond warmly").is_none());
        let corpus = "France: Its capital, largest city and main cultural and economic centre is Paris.";
        assert_eq!(
            direct_capital_answer("what is the capital of France", corpus).as_deref(),
            Some("The capital of France is Paris.")
        );
        // Must not swallow "and its…" after the city name.
        let de = "Germany: Its capital and largest city is Berlin and its …";
        assert_eq!(
            direct_capital_answer("capital of Germany", de).as_deref(),
            Some("The capital of Germany is Berlin.")
        );
        let jp = "Japan: With a population of almost 123\u{a0}million as of 2026, it is …";
        assert_eq!(
            direct_population_answer("what is the population of Japan", jp).as_deref(),
            Some("Japan has a population of about 123 million.")
        );
        assert!(title_rank("Population of Japan", "population of japan")
            > title_rank("Population of Jamaica", "population of japan"));
    }
}
