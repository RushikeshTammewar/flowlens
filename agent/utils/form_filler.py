"""Deterministic form filling with field-type detection.

Identifies field types from name, type, placeholder, label, and autocomplete
attributes, then fills with realistic test data. No AI needed for 90%+ of forms.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from playwright.async_api import Page

from agent.models.graph import ActionResult


@dataclass
class FormField:
    selector: str
    tag: str          # input | select | textarea
    input_type: str   # text | email | password | tel | number | search | url | ...
    name: str
    placeholder: str
    label: str
    autocomplete: str
    field_kind: str   # email | password | name | phone | search | address | url | number | date | generic


FIELD_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("email",    re.compile(r"e[-_]?mail", re.I)),
    ("password", re.compile(r"pass(word)?|pwd", re.I)),
    ("search",   re.compile(r"search|query|^q$|^s$", re.I)),
    ("phone",    re.compile(r"phone|tel|mobile|cell", re.I)),
    ("first_name", re.compile(r"first[-_]?name|fname|given", re.I)),
    ("last_name",  re.compile(r"last[-_]?name|lname|surname|family", re.I)),
    ("name",     re.compile(r"^name$|full[-_]?name|your[-_]?name|display[-_]?name|user[-_]?name", re.I)),
    ("address",  re.compile(r"address|street|addr", re.I)),
    ("city",     re.compile(r"city|town", re.I)),
    ("state",    re.compile(r"state|province|region", re.I)),
    ("zip",      re.compile(r"zip|postal|postcode", re.I)),
    ("country",  re.compile(r"country", re.I)),
    ("company",  re.compile(r"company|org|business", re.I)),
    ("url",      re.compile(r"url|website|site|homepage", re.I)),
    ("message",  re.compile(r"message|comment|body|content|description|note|text", re.I)),
    ("subject",  re.compile(r"subject|title|topic", re.I)),
    ("number",   re.compile(r"amount|quantity|qty|count|age", re.I)),
    ("date",     re.compile(r"date|dob|birth", re.I)),
    ("card",     re.compile(r"card|cc[-_]?num|credit", re.I)),
    ("cvv",      re.compile(r"cvv|cvc|security[-_]?code", re.I)),
]

from agent.utils.test_data import get_form_data as _get_form_data

TEST_DATA: dict[str, str] = {
    "email": _get_form_data("email"),
    "password": _get_form_data("password"),
    "search": _get_form_data("search"),
    "phone": _get_form_data("phone"),
    "first_name": _get_form_data("first_name"),
    "last_name": _get_form_data("last_name"),
    "name": _get_form_data("name"),
    "address": _get_form_data("address"),
    "city": _get_form_data("city"),
    "state": _get_form_data("state"),
    "zip": _get_form_data("zip"),
    "country": _get_form_data("country"),
    "company": _get_form_data("company"),
    "url": _get_form_data("url"),
    "message": _get_form_data("message"),
    "subject": _get_form_data("subject"),
    "number": _get_form_data("number"),
    "date": _get_form_data("date"),
    "card": _get_form_data("card"),
    "cvv": _get_form_data("cvv"),
    "generic": _get_form_data("generic"),
}


def _classify_field(name: str, input_type: str, placeholder: str,
                    label: str, autocomplete: str) -> str:
    """Determine what kind of data a form field expects."""
    if input_type == "email":
        return "email"
    if input_type == "password":
        return "password"
    if input_type == "tel":
        return "phone"
    if input_type == "search":
        return "search"
    if input_type == "url":
        return "url"
    if input_type == "number":
        return "number"
    if input_type == "date":
        return "date"

    ac = autocomplete.lower()
    if ac in ("email",):
        return "email"
    if ac in ("tel", "tel-national"):
        return "phone"
    if ac in ("given-name",):
        return "first_name"
    if ac in ("family-name",):
        return "last_name"
    if ac in ("name", "username"):
        return "name"
    if ac in ("street-address", "address-line1"):
        return "address"
    if ac in ("postal-code",):
        return "zip"
    if ac in ("organization",):
        return "company"
    if ac in ("url",):
        return "url"

    combined = f"{name} {placeholder} {label}"
    for kind, pattern in FIELD_PATTERNS:
        if pattern.search(combined):
            return kind

    return "generic"


_EXTRACT_FIELDS_JS = """(formSelector) => {
    const form = document.querySelector(formSelector);
    if (!form) return [];
    const fields = [];
    const inputs = form.querySelectorAll('input, select, textarea');
    for (const el of inputs) {
        const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
        if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;

        // Find associated label
        let labelText = '';
        if (el.id) {
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            if (lbl) labelText = lbl.textContent.trim().substring(0, 100);
        }
        if (!labelText) {
            const parent = el.closest('label');
            if (parent) labelText = parent.textContent.trim().substring(0, 100);
        }

        const idx = [...inputs].filter(x => {
            const t = (x.getAttribute('type') || x.tagName.toLowerCase()).toLowerCase();
            return !['hidden','submit','button','reset','image','file'].includes(t);
        }).indexOf(el);

        fields.push({
            selector: formSelector + ` :nth-child(${idx + 1}) input, ` + formSelector + ` input:nth-of-type(${idx + 1})`,
            uniqueSelector: el.id ? `#${el.id}` : (el.name ? `${formSelector} [name="${el.name}"]` : `${formSelector} ${el.tagName.toLowerCase()}:nth-of-type(${idx + 1})`),
            tag: el.tagName.toLowerCase(),
            inputType: type,
            name: el.name || '',
            placeholder: el.placeholder || '',
            label: labelText,
            autocomplete: el.autocomplete || '',
        });
    }
    return fields;
}"""


async def identify_fields(page: Page, form_selector: str) -> list[FormField]:
    """Extract and classify all fillable fields in a form."""
    try:
        raw = await page.evaluate(_EXTRACT_FIELDS_JS, form_selector)
    except Exception:
        return []

    fields = []
    for f in raw:
        kind = _classify_field(
            f["name"], f["inputType"], f["placeholder"],
            f["label"], f["autocomplete"],
        )
        fields.append(FormField(
            selector=f["uniqueSelector"],
            tag=f["tag"],
            input_type=f["inputType"],
            name=f["name"],
            placeholder=f["placeholder"],
            label=f["label"],
            autocomplete=f["autocomplete"],
            field_kind=kind,
        ))
    return fields


async def fill_form(page: Page, form_selector: str) -> ActionResult:
    """Fill a form with test data and submit it. Returns the action result."""
    fields = await identify_fields(page, form_selector)
    if not fields:
        return ActionResult(
            action_type="fill_form",
            target=form_selector,
            outcome="no_change",
            error="No fillable fields found",
        )

    url_before = page.url
    filled_count = 0

    for f in fields:
        value = TEST_DATA.get(f.field_kind, TEST_DATA["generic"])
        try:
            el = await page.query_selector(f.selector)
            if not el:
                continue
            if not await el.is_visible():
                continue

            if f.tag == "select":
                options = await el.evaluate("""el => [...el.options]
                    .filter(o => o.value && !o.disabled)
                    .map(o => o.value)""")
                if options:
                    await el.select_option(options[0])
                    filled_count += 1
            elif f.tag == "textarea":
                await el.fill(value)
                filled_count += 1
            elif f.input_type == "checkbox":
                if not await el.is_checked():
                    await el.check()
                filled_count += 1
            elif f.input_type == "radio":
                if not await el.is_checked():
                    await el.check()
                filled_count += 1
            else:
                await el.fill(value)
                filled_count += 1
        except Exception:
            continue

    # Try to submit
    try:
        submit = await page.query_selector(f"{form_selector} button[type=submit], {form_selector} input[type=submit], {form_selector} button:not([type])")
        if submit and await submit.is_visible():
            await submit.click()
        else:
            await page.evaluate(f"document.querySelector('{form_selector}')?.submit()")
        await page.wait_for_timeout(2000)
    except Exception:
        pass

    url_after = page.url
    navigated = url_after != url_before

    return ActionResult(
        action_type="fill_form",
        target=form_selector,
        outcome="navigated" if navigated else "new_content",
        new_url=url_after if navigated else None,
    )
