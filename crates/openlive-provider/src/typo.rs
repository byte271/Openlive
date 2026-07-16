//! Lightweight ASR / typing typo correction for search queries.

/// Correct common speech-to-text and typing mistakes before tools run.
pub fn correct_typos(input: &str) -> String {
    let mut s = input.trim().to_owned();
    if s.is_empty() {
        return s;
    }

    // Phrase-level fixes (order matters — longer first).
    let phrases: &[(&str, &str)] = &[
        ("check gpt", "ChatGPT"),
        ("checkgpt", "ChatGPT"),
        ("chat gpt", "ChatGPT"),
        ("chatgbt", "ChatGPT"),
        ("chat gbt", "ChatGPT"),
        ("open ai", "OpenAI"),
        ("openi", "OpenAI"),
        ("what is agent", "what is an AI agent"),
        ("whats an agent", "what is an AI agent"),
        ("what's an agent", "what is an AI agent"),
        ("what is an agent", "what is an AI agent"),
        ("ai agant", "AI agent"),
        ("ai ajent", "AI agent"),
        ("softwear agent", "software agent"),
        ("capitl of", "capital of"),
        ("capitel of", "capital of"),
        ("populaton of", "population of"),
        ("wikipdia", "wikipedia"),
        ("googel", "google"),
        ("microsft", "microsoft"),
        ("appl e", "apple"),
    ];

    let lower = s.to_ascii_lowercase();
    for (bad, good) in phrases {
        if lower.contains(bad) {
            // Case-insensitive replace of first occurrence.
            if let Some(i) = lower.find(bad) {
                s = format!("{}{}{}", &s[..i], good, &s[i + bad.len()..]);
                break;
            }
        }
    }

    // Token-level fixes.
    let tokens: Vec<String> = s
        .split_whitespace()
        .map(|tok| {
            let t = tok.to_ascii_lowercase();
            match t.as_str() {
                "ajent" | "agant" | "agen" => "agent".into(),
                "chatgptg" | "chatgtp" => "ChatGPT".into(),
                "goggle" | "googel" => "Google".into(),
                "microsft" | "micosoft" => "Microsoft".into(),
                "wikipidea" | "wikipdia" => "Wikipedia".into(),
                "recieve" => "receive".into(),
                "seperate" => "separate".into(),
                "definately" => "definitely".into(),
                _ => tok.to_owned(),
            }
        })
        .collect();
    tokens.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixes_check_gpt_and_agent() {
        assert!(correct_typos("search what is check gpt")
            .to_ascii_lowercase()
            .contains("chatgpt"));
        assert!(correct_typos("what is agent")
            .to_ascii_lowercase()
            .contains("ai agent"));
    }
}
