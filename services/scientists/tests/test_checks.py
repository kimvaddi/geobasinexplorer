"""The deterministic number check, ported from version 1's deterministicCheck."""
from gbx_scientists.checks import title_of, unsupported_numbers

EVIDENCE = "Top Toolachee 6326 ft below KB. Report KB elevation 181.9 ft."


def test_a_cited_document_title_and_cited_pages_are_set_aside_as_in_version_1():
    title = "Marabooka 1 · Marabooka No. 1 Well Completion Report"
    assert unsupported_numbers("Top Toolachee in Marabooka 1 is 6326 ft below KB.", EVIDENCE, [title]) == []
    assert unsupported_numbers("Top Toolachee in Marabooka 1 is 6326 ft below KB.", EVIDENCE) == ["1"]
    assert unsupported_numbers("Page 25 gives a KB elevation of 181.9 ft.", EVIDENCE, pages=[25]) == []
    assert unsupported_numbers("Page 26 gives a KB elevation of 181.9 ft.", EVIDENCE, pages=[25]) == ["26"]


def test_numbers_must_be_stated_or_convert_at_the_precision_written():
    assert unsupported_numbers("The top is 6326 ft (1928.2 m) below KB.", EVIDENCE) == []
    assert unsupported_numbers("The top is 6326 ft (1928.9 m) below KB.", EVIDENCE) == ["1928.9"]
    assert unsupported_numbers("The top is 6144.1 ft below sea level.", EVIDENCE) == ["6144.1"]
    assert unsupported_numbers("The interval is 6412-6454 ft.", "Perforated 6412 to 6454 ft.") == []


def test_a_number_from_the_persons_own_hypothesis_may_be_restated_but_no_other():
    hypothesis = "The Toolachee Formation at Marabooka 1 lies deeper than 6,000 ft below KB."
    assert unsupported_numbers("The top, at 6326 ft, is deeper than the 6,000 ft in the hypothesis.", EVIDENCE, question=hypothesis) == []
    assert unsupported_numbers("The top, at 6326 ft, is deeper than 5,000 ft.", EVIDENCE, question=hypothesis) == ["5,000"]


def test_title_of_strips_the_page_and_provenance_suffix():
    assert title_of("Marabooka 1 report, native PDF page 25 (live)") == "Marabooka 1 report"
    assert title_of("Marabooka 1 · Marabooka No. 1 Well Completion Report, page 12 (packaged snapshot)") == "Marabooka 1 · Marabooka No. 1 Well Completion Report"


def test_long_lines_are_clipped_at_a_boundary():
    from gbx_scientists.workflow import _clip
    assert _clip("Short line.", 300) == "Short line."
    two = "The first sentence is complete. " + "word " * 80
    assert _clip(two, 60) == "The first sentence is complete.…"
    one = "word " * 80
    clipped = _clip(one, 120)
    assert clipped.endswith("word…") and len(clipped) <= 120
