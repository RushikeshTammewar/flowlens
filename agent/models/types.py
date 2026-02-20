from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class Severity(str, Enum):
    P0 = "P0"
    P1 = "P1"
    P2 = "P2"
    P3 = "P3"
    P4 = "P4"


class Category(str, Enum):
    FUNCTIONAL = "functional"
    VISUAL = "visual"
    RESPONSIVE = "responsive"
    PERFORMANCE = "performance"
    ACCESSIBILITY = "accessibility"
    SECURITY = "security"


class Confidence(str, Enum):
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


@dataclass
class BugFinding:
    title: str
    category: Category
    severity: Severity
    confidence: Confidence
    page_url: str
    viewport: str = "desktop"
    description: str = ""
    evidence: dict = field(default_factory=dict)
    screenshot_path: str | None = None
    detected_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "category": self.category.value,
            "severity": self.severity.value,
            "confidence": self.confidence.value,
            "page_url": self.page_url,
            "viewport": self.viewport,
            "description": self.description,
            "evidence": self.evidence,
            "screenshot_path": self.screenshot_path,
            "detected_at": self.detected_at.isoformat(),
        }


@dataclass
class PageMetrics:
    url: str
    viewport: str
    load_time_ms: int = 0
    ttfb_ms: int = 0
    fcp_ms: int | None = None
    dom_node_count: int = 0
    request_count: int = 0
    transfer_bytes: int = 0


@dataclass
class CrawlResult:
    url: str
    pages_tested: int = 0
    bugs: list[BugFinding] = field(default_factory=list)
    metrics: list[PageMetrics] = field(default_factory=list)
    pages_visited: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    started_at: datetime = field(default_factory=datetime.now)
    completed_at: datetime | None = None
    health_score: int | None = None
