---
name: pptx
description: Create branded PowerPoint presentations using python-pptx. Loads a .pptx template from the group folder, adds slides with text and bullets, and sends the result back via Telegram.
---

# PowerPoint Presentation Creator

Create .pptx presentations using the user's branded template.

## Prerequisites

- **Template:** The user uploads a `.pptx` template file to Telegram. It is saved as `/workspace/group/template.pptx` (or another name — check what files exist).
- **python-pptx:** Installed in the container (`python3 -c "import pptx"` to verify).

## Workflow

1. Check for template: `ls /workspace/group/*.pptx`
2. If no template exists, ask the user to send one via Telegram first.
3. Discover available layouts from the template (see script below).
4. Write a Python script that creates the presentation.
5. Save output to `/workspace/group/<name>.pptx`
6. Send via `send_file` MCP tool.

## Step 1: Discover template layouts

Always run this first to see what layouts the template provides:

```python
from pptx import Presentation
prs = Presentation('/workspace/group/template.pptx')
for i, layout in enumerate(prs.slide_layouts):
    print(f"Layout {i}: {layout.name}")
    for ph in layout.placeholders:
        print(f"  Placeholder {ph.placeholder_format.idx}: {ph.name} ({ph.placeholder_format.type})")
```

Common layout names: "Title Slide", "Title and Content", "Section Header", "Blank", "Two Content".

## Step 2: Create slides

```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation('/workspace/group/template.pptx')

# --- Title slide ---
slide = prs.slides.add_slide(prs.slide_layouts[0])  # Usually "Title Slide"
slide.placeholders[0].text = "Presentation Title"
slide.placeholders[1].text = "Subtitle or date"

# --- Content slide with bullets ---
slide = prs.slides.add_slide(prs.slide_layouts[1])  # Usually "Title and Content"
slide.placeholders[0].text = "Slide Title"
tf = slide.placeholders[1].text_frame
tf.text = "First bullet point"
for bullet in ["Second point", "Third point", "Fourth point"]:
    p = tf.add_paragraph()
    p.text = bullet
    p.level = 0  # 0 = top level, 1 = sub-bullet

# --- Section header ---
slide = prs.slides.add_slide(prs.slide_layouts[2])  # Usually "Section Header"
slide.placeholders[0].text = "Section Title"

# --- Save ---
output_path = '/workspace/group/output.pptx'
prs.save(output_path)
print(f"Saved to {output_path}")
```

## Step 3: Send the file

After the Python script completes, use the MCP tool:

```
send_file({ file_path: "output.pptx", caption: "Your presentation" })
```

## Tips

- **Layout indices vary by template.** Always discover layouts first.
- **Bullet levels:** `p.level = 0` for main bullets, `p.level = 1` for sub-bullets.
- **Font size:** `p.font.size = Pt(18)` — but prefer template defaults.
- **Multiple templates:** If user sends multiple .pptx files, ask which one to use.
- **Naming:** Use descriptive filenames like `Q1-results.pptx`, not `output.pptx`.
