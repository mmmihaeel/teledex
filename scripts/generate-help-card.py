#!/usr/bin/env python3

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "assets" / "help"
WIDTH = 1600
MIN_HEIGHT = 2400
MARGIN = 96

BACKGROUND = "#F8FAFC"
PANEL = "#FFFFFF"
INK = "#0F172A"
MUTED = "#475569"
BLUE = "#2563EB"
CYAN = "#0891B2"
LINE = "#DCE6F2"
CODE_BG = "#EFF6FF"
WARNING_BG = "#FFF7ED"
WARNING_INK = "#9A3412"


def load_font(size: int, bold: bool = False, mono: bool = False):
    windows = Path("C:/Windows/Fonts")
    candidates = []
    if mono:
        candidates.extend(
            [
                windows / "consola.ttf",
                Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
                Path("/usr/share/fonts/TTF/DejaVuSansMono.ttf"),
            ]
        )
    elif bold:
        candidates.extend(
            [
                windows / "segoeuib.ttf",
                windows / "arialbd.ttf",
                Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
                Path("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"),
            ]
        )
    else:
        candidates.extend(
            [
                windows / "segoeui.ttf",
                windows / "arial.ttf",
                Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
                Path("/usr/share/fonts/TTF/DejaVuSans.ttf"),
            ]
        )

    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


TITLE_FONT = load_font(80, bold=True)
SUBTITLE_FONT = load_font(31)
SECTION_FONT = load_font(36, bold=True)
COMMAND_FONT = load_font(26, bold=True, mono=True)
BODY_FONT = load_font(27)
SMALL_FONT = load_font(23)
BADGE_FONT = load_font(25, bold=True)


PAGES = [
    {
        "subtitle": "Daily command reference: start, route, and control work.",
        "sections": [
            (
                "Start and inspect",
                [
                    ("/help", "Send this two-page reference."),
                    ("/guide", "Send the complete operator guidebook PDF."),
                    ("/new <title>", "Create a durable work topic from General."),
                    ("/hosts  |  /host <id>", "Inspect local and remote execution hosts."),
                    ("/status  |  /limits", "Inspect session state and Codez usage windows."),
                    ("/global  |  /menu", "Open global or topic-local controls."),
                ],
            ),
            (
                "Prompt flow",
                [
                    ("plain text", "Start work now when the topic is idle."),
                    ("/q <text>", "Queue a prompt behind current work."),
                    ("/wait 60", "Open a one-shot topic buffer."),
                    ("/wait global 60", "Open a persistent chat-wide buffer."),
                    ("files during /wait", "Add prompt fragments and attachments."),
                    ("All", "Dispatch the collected prompt immediately."),
                    ("/wait off", "Cancel and clear the topic buffer."),
                ],
            ),
            (
                "Run control",
                [
                    ("/interrupt", "Stop the active run; inspect partial changes."),
                    ("/goal", "Inspect or change the App Server v2 goal."),
                    ("/compact", "Rebuild the durable brief from the exchange log."),
                    ("/diff", "Send the current workspace diff."),
                    ("/purge", "Request guarded deletion of Teledex session content."),
                ],
            ),
        ],
        "footer": "One topic maps to one durable session. Confirm the host and workspace before every sensitive run.",
    },
    {
        "subtitle": "Settings, files, lifecycle, and deployment boundaries.",
        "sections": [
            (
                "Session settings",
                [
                    ("/model", "Inspect or change the topic model."),
                    ("/model global <slug>", "Set the global default model."),
                    ("/reasoning", "Inspect or change topic reasoning."),
                    ("/reasoning global <level>", "Set the global default reasoning."),
                    ("/suffix <text>", "Set the topic prompt suffix."),
                    ("/suffix global <text>", "Set the shared prompt suffix."),
                ],
            ),
            (
                "Files and lifecycle",
                [
                    ("incoming files", "20 MiB soft limit."),
                    ("returned files", "45 MiB soft limit and bounded source paths."),
                    ("closed topic", "Session may park until the topic is usable."),
                    ("parked retention", "Eligible sessions age for 168 hours by default."),
                    ("/zoo", "Open the optional Project Catalog from General."),
                    ("private chat", "Runs emergency codex exec against the Teledex checkout."),
                ],
            ),
            (
                "Safety boundary",
                [
                    ("trusted operators", "Every allowlisted principal controls the host account."),
                    ("workspace binding", "Selects a start path; it is not a sandbox."),
                    ("emergency lane", "Human-only, one run, and blocked during normal runs."),
                    ("App Server v2", "Spawned locally on stdio or on a POSIX host over SSH."),
                    ("smoke", "Uses a live poller and can change webhook or offset state."),
                    ("state root", "Contains sensitive prompts, paths, files, and identifiers."),
                ],
            ),
        ],
        "footer": "Teledex runs Codez with danger-full-access and no interactive approvals. Use dedicated infrastructure.",
    },
]


def text_width(draw, text, font):
    return draw.textbbox((0, 0), text, font=font)[2]


def wrap_text(draw, text, font, max_width):
    words = text.split()
    lines = []
    current = []
    for word in words:
        candidate = " ".join(current + [word])
        if current and text_width(draw, candidate, font) > max_width:
            lines.append(" ".join(current))
            current = [word]
        else:
            current.append(word)
    if current:
        lines.append(" ".join(current))
    return lines


def draw_wrapped(draw, position, text, font, fill, max_width, line_gap=7):
    x, y = position
    lines = wrap_text(draw, text, font, max_width)
    line_height = draw.textbbox((0, 0), "Ag", font=font)[3]
    for line in lines:
        draw.text((x, y), line, font=font, fill=fill)
        y += line_height + line_gap
    return y


def row_height(draw, description):
    lines = wrap_text(draw, description, BODY_FONT, WIDTH - 2 * MARGIN - 100)
    return 75 + len(lines) * 39


def section_height(draw, rows):
    return 92 + sum(row_height(draw, description) for _, description in rows) + 26


def draw_header(draw, page_number, subtitle):
    draw.rounded_rectangle(
        (MARGIN, 72, WIDTH - MARGIN, 330),
        radius=42,
        fill=INK,
    )
    draw.rounded_rectangle(
        (MARGIN + 38, 104, MARGIN + 218, 154),
        radius=25,
        fill=CYAN,
    )
    draw.text(
        (MARGIN + 64, 115),
        "TELEDEX",
        font=BADGE_FONT,
        fill="#FFFFFF",
    )
    draw.text(
        (MARGIN + 40, 174),
        "Telegram operator reference",
        font=TITLE_FONT,
        fill="#FFFFFF",
    )
    draw.text(
        (MARGIN + 44, 277),
        subtitle,
        font=SUBTITLE_FONT,
        fill="#CBD5E1",
    )
    badge = f"{page_number} / {len(PAGES)}"
    badge_width = text_width(draw, badge, BADGE_FONT)
    draw.rounded_rectangle(
        (WIDTH - MARGIN - badge_width - 60, 104, WIDTH - MARGIN - 24, 158),
        radius=26,
        fill=BLUE,
    )
    draw.text(
        (WIDTH - MARGIN - badge_width - 42, 116),
        badge,
        font=BADGE_FONT,
        fill="#FFFFFF",
    )


def draw_section(draw, top, title, rows):
    height = section_height(draw, rows)
    left = MARGIN
    right = WIDTH - MARGIN
    draw.rounded_rectangle(
        (left, top, right, top + height),
        radius=34,
        fill=PANEL,
        outline=LINE,
        width=3,
    )
    draw.rounded_rectangle(
        (left + 30, top + 24, left + 380, top + 78),
        radius=27,
        fill=CODE_BG,
    )
    draw.text(
        (left + 52, top + 33),
        title,
        font=SECTION_FONT,
        fill=BLUE,
    )

    y = top + 104
    for index, (command, description) in enumerate(rows):
        if index:
            draw.line(
                (left + 38, y - 8, right - 38, y - 8),
                fill=LINE,
                width=2,
            )
        draw.rounded_rectangle(
            (left + 38, y + 4, right - 38, y + 46),
            radius=14,
            fill=CODE_BG,
        )
        draw.text(
            (left + 58, y + 10),
            command,
            font=COMMAND_FONT,
            fill=BLUE,
        )
        y = draw_wrapped(
            draw,
            (left + 58, y + 58),
            description,
            BODY_FONT,
            MUTED,
            right - left - 116,
        )
        y += 17
    return top + height


def draw_footer(draw, text, page_height):
    top = page_height - 174
    draw.rounded_rectangle(
        (MARGIN, top, WIDTH - MARGIN, page_height - 72),
        radius=28,
        fill=WARNING_BG,
    )
    draw_wrapped(
        draw,
        (MARGIN + 38, top + 25),
        text,
        SMALL_FONT,
        WARNING_INK,
        WIDTH - 2 * MARGIN - 76,
        line_gap=5,
    )


def render_page(page_number, page):
    probe = Image.new("RGB", (WIDTH, 32), BACKGROUND)
    probe_draw = ImageDraw.Draw(probe)
    section_total = sum(
        section_height(probe_draw, rows) for _, rows in page["sections"]
    )
    gap = 28
    page_height = max(
        MIN_HEIGHT,
        378 + section_total + gap * (len(page["sections"]) - 1) + 220,
    )

    image = Image.new("RGB", (WIDTH, page_height), BACKGROUND)
    draw = ImageDraw.Draw(image)
    draw_header(draw, page_number, page["subtitle"])

    top = 378
    for title, rows in page["sections"]:
        top = draw_section(draw, top, title, rows) + gap

    draw_footer(draw, page["footer"], page_height)
    return image


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for page_number, page in enumerate(PAGES, start=1):
        output_path = OUTPUT_DIR / f"telegram-help-card-eng-{page_number}.png"
        render_page(page_number, page).save(
            output_path,
            format="PNG",
            optimize=True,
        )
        print(output_path)


if __name__ == "__main__":
    main()
