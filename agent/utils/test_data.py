"""Context-aware test data generation.

Generates realistic search queries, form data, and negative test values
based on the site type and page context. Unique data per run to avoid
"email already registered" errors.
"""

from __future__ import annotations

import random
import uuid
from urllib.parse import urlparse


def detect_site_type(url: str, page_text: str = "") -> str:
    """Detect site type from URL and page content."""
    domain = urlparse(url).netloc.lower()
    path = urlparse(url).path.lower()
    text = page_text.lower()[:3000]

    scores = {
        "ecommerce": 0,
        "news": 0,
        "saas": 0,
        "docs": 0,
        "social": 0,
        "forum": 0,
        "blog": 0,
        "education": 0,
        "generic": 0,
    }

    ecommerce_signals = ["shop", "store", "cart", "buy", "price", "product", "checkout", "order", "shipping", "amazon", "shopify", "ebay"]
    news_signals = ["news", "article", "journalist", "reporter", "breaking", "politics", "nytimes", "reuters", "bbc"]
    saas_signals = ["pricing", "signup", "dashboard", "enterprise", "api", "developer", "platform", "subscribe", "trial", "demo"]
    docs_signals = ["documentation", "docs", "api reference", "getting started", "tutorial", "guide", "readme"]
    social_signals = ["profile", "follow", "post", "feed", "like", "comment", "share", "tweet", "reddit", "facebook"]
    forum_signals = ["forum", "thread", "reply", "discussion", "topic", "community", "hacker news", "stack"]
    blog_signals = ["blog", "post", "author", "published", "medium", "wordpress"]
    education_signals = ["course", "learn", "lesson", "student", "teacher", "university", "academy"]

    for signals, stype in [
        (ecommerce_signals, "ecommerce"), (news_signals, "news"),
        (saas_signals, "saas"), (docs_signals, "docs"),
        (social_signals, "social"), (forum_signals, "forum"),
        (blog_signals, "blog"), (education_signals, "education"),
    ]:
        for signal in signals:
            if signal in domain:
                scores[stype] += 3
            if signal in text:
                scores[stype] += 1

    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else "generic"


_SEARCH_QUERIES: dict[str, list[str]] = {
    "ecommerce": ["laptop", "wireless headphones", "running shoes", "phone case", "usb cable", "backpack"],
    "news": ["technology", "climate change", "politics", "sports", "economy", "science"],
    "saas": ["getting started", "integration", "pricing", "API", "tutorial", "help"],
    "docs": ["getting started", "API reference", "quickstart", "installation", "examples", "configuration"],
    "social": ["trending", "popular", "technology", "news", "music", "photography"],
    "forum": ["help", "question", "how to", "recommendation", "best practice", "tutorial"],
    "blog": ["tutorial", "guide", "review", "tips", "best practices", "introduction"],
    "education": ["python", "javascript", "machine learning", "data science", "web development"],
    "generic": ["test", "example", "search", "help", "about"],
}


def get_search_query(site_type: str) -> str:
    """Get a realistic search query for the site type."""
    queries = _SEARCH_QUERIES.get(site_type, _SEARCH_QUERIES["generic"])
    return random.choice(queries)


def get_unique_email() -> str:
    """Generate a unique email that won't collide with existing accounts."""
    uid = uuid.uuid4().hex[:8]
    return f"flowlens.test.{uid}@gmail.com"


def get_form_data(field_kind: str) -> str:
    """Get test data for a form field type, with unique values where needed."""
    unique_data = {
        "email": get_unique_email(),
        "password": "FlowLens!Test2026",
        "search": "test query",
        "phone": f"555-{random.randint(1000, 9999)}",
        "first_name": random.choice(["Jane", "John", "Alex", "Sam", "Jordan"]),
        "last_name": random.choice(["Doe", "Smith", "Johnson", "Lee", "Garcia"]),
        "name": random.choice(["Jane Doe", "John Smith", "Alex Johnson"]),
        "address": f"{random.randint(100, 999)} Test Street",
        "city": random.choice(["San Francisco", "New York", "Austin", "Seattle", "Chicago"]),
        "state": random.choice(["CA", "NY", "TX", "WA", "IL"]),
        "zip": f"{random.randint(10000, 99999)}",
        "country": "United States",
        "company": "FlowLens QA",
        "url": "https://flowlens.in",
        "message": "This is an automated test from FlowLens QA engine.",
        "subject": "FlowLens Automated Test",
        "number": str(random.randint(1, 100)),
        "date": "2026-01-15",
        "card": "4111111111111111",
        "cvv": "123",
        "generic": "test input",
    }
    return unique_data.get(field_kind, unique_data["generic"])


# Negative test values for adversarial testing
NEGATIVE_TEST_VALUES = {
    "empty": "",
    "xss": "<script>alert('xss')</script>",
    "sql_injection": "' OR 1=1 --",
    "very_long": "A" * 500,
    "unicode": "日本語テスト 🎯 αβγ",
    "special_chars": "!@#$%^&*(){}[]|\\:\";<>?,./~`",
    "spaces_only": "   ",
    "html_tags": "<b>bold</b><img src=x onerror=alert(1)>",
    "newlines": "line1\nline2\nline3",
    "negative_number": "-1",
    "zero": "0",
    "email_invalid": "not-an-email",
}


def get_negative_value(variant: str) -> str:
    """Get a specific negative test value."""
    return NEGATIVE_TEST_VALUES.get(variant, "")
