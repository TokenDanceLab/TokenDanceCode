from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ReviewFinding:
    message: str
    severity: str = "warning"


@dataclass(frozen=True)
class ReviewReport:
    findings: list[ReviewFinding]


class ReviewService:
    def review_diff(self, diff: str) -> ReviewReport:
        findings: list[ReviewFinding] = []
        if "<<<<<<<" in diff or ">>>>>>>" in diff:
            findings.append(ReviewFinding("Diff contains merge conflict markers.", "error"))
        if "+TODO" in diff or "+ TODO" in diff:
            findings.append(ReviewFinding("Diff adds TODO text; confirm it is intentional.", "warning"))
        return ReviewReport(findings=findings)
