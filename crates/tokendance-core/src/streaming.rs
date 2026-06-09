/// A parsed SSE event from an HTTP streaming response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event_type: Option<String>,
    pub data: String,
    pub id: Option<String>,
}

/// Parse a complete SSE text buffer into individual events.
///
/// SSE format: lines of "field: value", events separated by blank lines.
pub fn parse_sse_buffer(buffer: &str) -> Vec<SseEvent> {
    let mut events = Vec::new();
    // Split on double newlines (\n\n) to get event blocks
    for block in buffer.split("\n\n") {
        if block.trim().is_empty() {
            continue;
        }
        if let Some(event) = parse_event_block(block) {
            events.push(event);
        }
    }
    events
}

fn parse_event_block(block: &str) -> Option<SseEvent> {
    let mut event_type = None;
    let mut data_lines: Vec<String> = Vec::new();
    let mut id = None;

    for line in block.lines() {
        // Skip comment lines starting with ":"
        if line.starts_with(':') {
            continue;
        }
        if line.is_empty() {
            continue;
        }

        if let Some(value) = line.strip_prefix("data:") {
            // "data:" with no space after colon is valid SSE; trim leading space only
            let trimmed = value.strip_prefix(' ').unwrap_or(value);
            data_lines.push(trimmed.to_string());
        } else if let Some(value) = line.strip_prefix("event:") {
            let trimmed = value.strip_prefix(' ').unwrap_or(value);
            event_type = Some(trimmed.to_string());
        } else if let Some(value) = line.strip_prefix("id:") {
            let trimmed = value.strip_prefix(' ').unwrap_or(value);
            id = Some(trimmed.to_string());
        }
        // Unknown fields are ignored per SSE spec
    }

    // An event with no data is not emitted
    if data_lines.is_empty() {
        return None;
    }

    Some(SseEvent {
        event_type,
        data: data_lines.join("\n"),
        id,
    })
}

/// Incremental SSE parser that handles partial buffers.
pub struct SseParser {
    buffer: String,
}

impl SseParser {
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
        }
    }

    /// Feed new bytes and return any complete events parsed.
    /// Incomplete events stay in the buffer for next call.
    pub fn feed(&mut self, chunk: &str) -> Vec<SseEvent> {
        self.buffer.push_str(chunk);
        let mut events = Vec::new();

        // Process complete event blocks (delimited by \n\n)
        while let Some(pos) = self.buffer.find("\n\n") {
            let block = self.buffer[..pos].to_string();
            self.buffer = self.buffer[pos + 2..].to_string();

            if block.trim().is_empty() {
                continue;
            }
            if let Some(event) = parse_event_block(&block) {
                events.push(event);
            }
        }

        events
    }

    /// Drain any remaining buffered data.
    pub fn finish(self) -> Option<SseEvent> {
        if self.buffer.trim().is_empty() {
            return None;
        }
        parse_event_block(&self.buffer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_complete_single_event() {
        let buffer = "data: hello world\n\n";
        let events = parse_sse_buffer(buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "hello world");
        assert_eq!(events[0].event_type, None);
        assert_eq!(events[0].id, None);
    }

    #[test]
    fn parse_event_with_all_fields() {
        let buffer = "event: message\ndata: hello\nid: 42\n\n";
        let events = parse_sse_buffer(buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, Some("message".to_string()));
        assert_eq!(events[0].data, "hello");
        assert_eq!(events[0].id, Some("42".to_string()));
    }

    #[test]
    fn parse_multiple_events() {
        let buffer = "data: first\n\ndata: second\n\n";
        let events = parse_sse_buffer(buffer);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].data, "first");
        assert_eq!(events[1].data, "second");
    }

    #[test]
    fn parse_multi_line_data() {
        let buffer = "data: line1\ndata: line2\ndata: line3\n\n";
        let events = parse_sse_buffer(buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "line1\nline2\nline3");
    }

    #[test]
    fn skip_comment_lines() {
        let buffer = ": this is a comment\ndata: actual\n\n";
        let events = parse_sse_buffer(buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "actual");
    }

    #[test]
    fn skip_blocks_with_no_data() {
        let buffer = "event: ping\n\ndata: hello\n\n";
        let events = parse_sse_buffer(buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "hello");
    }

    #[test]
    fn incremental_feed_parses_complete_events() {
        let mut parser = SseParser::new();
        let mut events = parser.feed("data: hel");
        assert!(events.is_empty());

        events = parser.feed("lo\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "hello");
    }

    #[test]
    fn incremental_feed_handles_multiple_chunks() {
        let mut parser = SseParser::new();
        let mut all_events = Vec::new();

        all_events.extend(parser.feed("data: first\n\ndata: sec"));
        all_events.extend(parser.feed("ond\n\n"));

        assert_eq!(all_events.len(), 2);
        assert_eq!(all_events[0].data, "first");
        assert_eq!(all_events[1].data, "second");
    }

    #[test]
    fn finish_drains_remaining_buffer() {
        let mut parser = SseParser::new();
        parser.feed("data: trailing");
        let event = parser.finish();
        assert!(event.is_some());
        assert_eq!(event.unwrap().data, "trailing");
    }

    #[test]
    fn finish_returns_none_for_empty_buffer() {
        let parser = SseParser::new();
        assert!(parser.finish().is_none());
    }

    #[test]
    fn parse_data_without_space_after_colon() {
        let buffer = "data:value\n\n";
        let events = parse_sse_buffer(buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "value");
    }

    #[test]
    fn parse_empty_data_field() {
        let buffer = "data:\n\n";
        let events = parse_sse_buffer(buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "");
    }

    #[test]
    fn parse_sse_done_signal() {
        let buffer = "data: [DONE]\n\n";
        let events = parse_sse_buffer(buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "[DONE]");
    }
}
