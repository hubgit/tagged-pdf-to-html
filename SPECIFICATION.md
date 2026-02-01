# PDF to HTML5 Derivation Algorithm - Technical Specification

**Version:** 1.1 (PDF 2.0 updates based on ISO 32000-2:2020)
**Document:** Deriving HTML from PDF
**Source:** PDF Association (pdfa.org)
**License:** CC-BY-4.0

---

## Executive Summary

This specification describes a deterministic algorithm for converting well-tagged PDF documents into conforming HTML5. The algorithm enables reliable reuse of PDF content in web environments while preserving semantic structure, accessibility features, and interactive elements.

It incorporates PDF 2.0 tagged-PDF updates, including the revised standard tag set, namespace handling (including MathML), pronunciation hints, document parts, and associated files.

---

## 1. Scope and Purpose

### 1.1 Objective

Convert well-tagged PDF files (conforming to ISO 32000-2 Tagged PDF or ISO 14289-1 PDF/UA-1) into syntactically valid HTML5 documents with accompanying CSS, including PDF 2.0 namespace-aware structure trees.

### 1.2 Target Audience

Software developers creating:
- PDF-to-HTML conversion tools
- Mobile document viewers
- Web-based PDF rendering engines
- Automated document processing systems

### 1.3 Out of Scope

This specification does NOT cover:
- Derivation into HTML sub-structures (e.g., within `<div>`)
- PDF or HTML editing/modification
- Security implementation details
- Accessibility best practices (see separate guidelines)

---

## 2. Key Concepts and Definitions

### 2.1 Core Terms

**Derivation**: Deterministic process of converting Tagged PDF into syntactically valid HTML

**Tagged PDF**: PDF files conforming to ISO 32000-2, §14.8 "Tagged PDF"

**Processor**: Software/hardware implementing this algorithm

**Derived HTML**: HTML output produced by conforming processors

**Derived CSS**: Default CSS stylesheet produced by conforming processors

**Structure Tree**: Hierarchical organization of PDF structure elements

**Media Type**: Two-part file format identifier (MIME type)

**Namespace**: Qualified identifier that determines which standard structure type set (PDF 1.7, PDF 2.0, MathML, HTML, or custom) applies to a structure element.

**PDF 1.7 Standard Structure Namespace (default)**: The standard structure namespace that applies when no namespace is explicitly specified; this remains the default in PDF 2.0 tagged PDFs.

**PDF 2.0 Standard Structure Namespace**: The revised standard tag set introduced in ISO 32000-2.

**Pronunciation Hint**: Metadata that provides speech pronunciation guidance for text content (based on W3C Pronunciation Lexicon Specification).

**Document Part**: PDF 2.0 metadata grouping that identifies logical parts of a document beyond the structure tree.

### 2.2 PDF Structure Elements

PDF uses semantic structure elements (similar to HTML) including:
- Document structure: `Document`, `DocumentFragment` (PDF 2.0), `Part`, `Sect`, `Div`
- Headings: `Title` (PDF 2.0), `H`, `H1`-`H6`, `Hn` (n>6)
- Paragraphs/notes: `P`, `Note`, `FENote` (PDF 2.0)
- Lists: `L`, `LI`, `Lbl`, `LBody`
- Tables: `Table`, `TR`, `TH`, `TD`, `THead`, `TBody`, `TFoot`
- Links: `Link`, `Reference`
- Forms: `Form`
- Figures: `Figure`, `Formula`, `Caption`
- Inline semantics: `Em`, `Strong`, `Sub` (PDF 2.0)

---

## 3. High-Level Algorithm Overview

### 3.1 Processing Flow

```
1. Initialize HTML and CSS output streams
2. Create HTML document structure
   ├─ DOCTYPE declaration
   ├─ <html> element
   ├─ <head> element
   │  ├─ Extract metadata (title, charset, viewport)
   │  └─ Process ClassMap → CSS
   └─ <body> element
      └─ Process structure tree (depth-first traversal)
3. For each structure element:
   ├─ Resolve namespace (PDF 1.7 vs PDF 2.0 vs MathML/HTML)
   ├─ Apply role mapping
   ├─ Determine HTML element
   ├─ Process attributes → HTML attributes or CSS
   ├─ Handle special cases
   └─ Process content/children
4. Handle associated files
5. Derive ECMAScript to JavaScript
```

### 3.2 Processing Order

- **Traversal**: Depth-first, pre-order traversal of structure tree
- **Attribute Priority**: List > Table > Layout > HTML > CSS > ARIA
- **Namespace Resolution**: PDF 2.0/PDF 1.7 → MathML → HTML → Custom

---

## 4. Document Structure Processing

### 4.1 HTML Head Element

#### 4.1.1 DOCTYPE and Root
```html
<!DOCTYPE html>
<html>
```

#### 4.1.2 Required Head Elements

1. **Title Element**
   - Source: `dc:title` from PDF XMP metadata
   - Fallback: PDF filename

2. **Character Encoding**
   ```html
   <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
   ```

3. **Viewport Meta**
   ```html
   <meta name="viewport" content="width=device-width, initial-scale=1"/>
   ```

4. **CSS Link**
   ```html
   <link rel="stylesheet" type="text/css" href="pdf-derivation-style.css"/>
   ```

### 4.2 ClassMap Processing

The ClassMap defines reusable attribute classes for styling.

**Algorithm:**
1. Iterate ClassMap dictionary entries
2. For each key: Create CSS selector (prepend with `.`)
3. For each attribute object:
   - If maps to CSS property → Add to derived CSS
   - If maps to HTML attribute → Save for element processing
4. Output CSS declarations

**Example:**
```
PDF ClassMap:
  /HeadingStyle << /O /CSS-2.00 /color /red /font-size (40px) >>

Derived CSS:
  .HeadingStyle { color: red; font-size: 40px; }
```

### 4.3 Body Element

**Structure:**
```html
<body>  <!-- lang from PDF Catalog dictionary is set on <html> -->
  <!-- Children derived from structure tree -->
  <form name="acroform" id="acroform"></form>  <!-- If interactive forms exist -->
</body>
```

### 4.4 Document Parts (PDF 2.0)

PDF 2.0 introduces document parts metadata that may not map cleanly to HTML elements.

**Guidance:**
- Processors SHOULD preserve document parts as metadata.
- Recommended output: a JSON serialization embedded in `<head>`:
  ```html
  <script type="application/pdf-document-parts+json">{...}</script>
  ```
- If a document part explicitly references structure elements, processors MAY add `data-pdf-document-part` attributes to the corresponding HTML elements.

---

## 5. Structure Element Mapping

### 5.1 Role Mapping Process

**For elements WITHOUT explicit namespace:**

1. Apply the default standard structure namespace (PDF 1.7, even in PDF 2.0 documents)
2. Check RoleMap in structure tree root
3. Apply role mapping transitively until reaching standard type
4. Add `data-pdf-se-type-original` attribute with original type(s) when different from the final standard type
5. Add `data-pdf-se-type` attribute with final standard type
6. Select HTML element from mapping table

**For elements WITH explicit namespace:**

- **PDF 2.0 Standard Namespace** → Use mapping table (PDF 2.0 element set)
- **PDF 1.7 Standard Namespace** → Use mapping table (PDF 1.7 element set)
- **MathML Namespace** → Use structure type directly as MathML element
- **HTML Namespace** → MAY use structure type directly (security risks!)
- **Other Namespaces** → Apply role mapping until reaching known namespace

#### 5.1.1 PDF 2.0 Namespace Interoperability

- Documents that use both PDF 1.7 and PDF 2.0 standard structure namespaces MUST be versioned as PDF 2.0.
- If a structure type exists in both namespaces, use the PDF 2.0 namespace for that element.
- If a structure type exists only in the PDF 1.7 namespace, it MAY appear as a child of a PDF 2.0 element subject to PDF 2.0 inclusion rules.

### 5.2 Standard Element Mappings

#### 5.2.1 Document Structure

| PDF Element | HTML Element | Notes |
|-------------|--------------|-------|
| Document | `<div>` | Root of structure tree |
| DocumentFragment | `<div>` | PDF 2.0 fragment of a document |
| Part | `<div>` | Document division |
| Sect | `<section>` | Document section |
| Art | `<article>` | Self-contained content |
| Aside | `<aside>` | Tangential content |
| Div | `<div>` | Generic division |

#### 5.2.2 Headings

| PDF Element | HTML Element | Notes |
|-------------|--------------|-------|
| H | `<h1>`-`<h6>` or `<p>` | Based on nesting level |
| H1-H6 | `<h1>`-`<h6>` or `<p>` | Direct mapping or fallback |
| Hn (n>6) | `<p>` | Use ARIA: `role="heading" aria-level="n"` |
| Title | `<h1>` or `<p>` | PDF 2.0 document title structure element (not HTML `<title>`) |

#### 5.2.3 Block Elements

| PDF Element | HTML Element |
|-------------|--------------|
| P | `<p>` |
| BlockQuote | `<blockquote>` |
| Note | `<p>` |
| FENote | `<aside>` |
| Code | `<code>` |

#### 5.2.4 Inline Elements

| PDF Element | HTML Element |
|-------------|--------------|
| Span | `<span>` |
| Quote | `<q>` |
| Em | `<em>` |
| Strong | `<strong>` |
| Sub | `<sub>` |
| Link | `<a>` |
| Reference | `<a>` |

#### 5.2.5 Lists

| PDF Element | HTML Element | Condition |
|-------------|--------------|-----------|
| L | `<ol>` | If ListNumbering=Ordered |
| L | `<ul>` | If ListNumbering=Unordered |
| L | `<dl>` | If ListNumbering=Description |
| LI | `<li>` or `<div>` | Depends on parent list type |
| Lbl | `<label>`, `<span>`, `<div>`, or `<dt>` | Context-dependent |
| LBody | `<div>` or `<dd>` | Context-dependent |

#### 5.2.6 Tables

| PDF Element | HTML Element |
|-------------|--------------|
| Table | `<table>` |
| TR | `<tr>` |
| TH | `<th>` |
| TD | `<td>` |
| THead | `<thead>` |
| TBody | `<tbody>` |
| TFoot | `<tfoot>` |
| Caption | `<caption>` or `<figcaption>` |

#### 5.2.7 Figures and Media

| PDF Element | HTML Element | Notes |
|-------------|--------------|-------|
| Figure | `<figure>` | Special handling for inline figures |
| Formula | `<figure>` | Mathematical content |
| Caption | `<figcaption>` or `<caption>` | Context-dependent |

#### 5.2.8 Ruby Annotation

| PDF Element | HTML Element |
|-------------|--------------|
| Ruby | `<ruby>` |
| RB | `<rb>` |
| RT | `<rt>` |
| RP | `<rp>` |
| Warichu | `<span>` |
| WT | `<span>` |
| WP | `<span>` |

#### 5.2.9 Special Elements

| PDF Element | HTML Element | Processing |
|-------------|--------------|------------|
| NonStruct | None | Element not output, content processed normally |
| Private | None | Element AND content not output |
| Artifact | None | Element AND content not output |
| TOC | `<ol>` | Table of contents |
| TOCI | `<li>` | Table of contents item |
| Index | `<section>` | Document index |
| BibEntry | `<p>` | Bibliography entry |

---

## 6. Special Processing Cases

### 6.1 Headings (H, H1-Hn, Title)

**H7 and Beyond:**
- Map to `<p>` element
- Add ARIA attributes: `role="heading"` and `aria-level="N"`

**Example:**
```html
<p role="heading" aria-level="7">Heading 7</p>
```

**Title (PDF 2.0):**
- Treat as a heading in the structure tree (not `<head><title>`)
- Apply the same heading-level resolution as `H`

### 6.2 Captions

#### 6.2.1 Captions of Figures/Formulas
- Use `<figcaption>` element
- Must be direct or immediate sibling
- Becomes first child of parent `<figure>`

#### 6.2.2 Captions of Tables
- Use `<caption>` element
- Must be direct or immediate sibling
- Becomes first child of parent `<table>`
- If caption contains nested table → Move nested table outside parent

### 6.3 Labels (Lbl)

**Within List Items:**
- If parent L derives to `<ul>` or `<ol>`:
  - Lbl → `<span>` (text only) or `<div>` (contains structure elements)
  - Parent list gets `style="list-style-type:none;"`
- If parent L derives to `<dl>`:
  - Lbl → `<dt>`

**Within Forms:**
- Lbl → `<div>` if contains Form, Figure, Formula, or Caption
- Lbl → `<label>` otherwise
  - For PDF 2.0: Add `for` attribute linking to form field

### 6.4 Figures and Formulas (Inline)

**When child of P, H, Hn, Em, Strong, or Span:**
- Don't map to `<figure>` element
- Process children directly
- Map children to `<span>` elements

### 6.5 Lists (L)

#### 6.5.1 Nested Lists
When L is child of L:
- Create intermediate `<li>` element
- Child list becomes child of this `<li>`

#### 6.5.2 Lists within Paragraphs
When L is child of P or Sub:
- Close HTML elements until parent allows `<ol>`, `<ul>`, or `<dl>`
- Insert list at this level
- Recreate structure for following siblings

### 6.6 Table Headers (TH)

**Restrictions:**
- Heading elements (H, H1-Hn) inside TH → Map to `<p>`
- Section elements (Sect) inside TH → Map to `<div>`

### 6.7 Links and References

**Processing:**
1. Map to `<a>` element
2. Get href from first OBJR annotation:
   - If annotation has A key with URI action → Use URI value
   - If annotation has Dest key → Use structured destination ID
   - If destination targets a structure element (PDF 2.0 GoTo/GoToR extension) → Link to `#<element-id>` (generate ID if missing)
3. If Link is child of Reference → Output only one `<a>` element

### 6.8 Forms (Form Elements)

**PDF 1.7 vs PDF 2.0:**
- **PDF 1.7**: Form element contains single widget annotation
- **PDF 2.0**: Form element contains widget annotation AND may contain Lbl elements

**Processing:** See Section 9 (Widget Annotations)

---

## 7. Structure Element Properties

### 7.1 Common Properties

**ID Attribute:**
- If PDF structure element has ID entry → Use as HTML `id` attribute
- If a structured destination references element without ID → Generate unique ID

**Class Attribute:**
- If structure element has C key → Use as HTML `class` attribute
- If C is array → Concatenate with spaces

**Lang Attribute:**
- If structure element has Lang entry (not empty) → Add `lang` attribute

### 7.2 Replacement Text (ActualText)

**Processing:**
- If ActualText key exists → Use as element content
- Ignore all children

**Example:**
```
PDF: <Span ActualText="c">{k-}
HTML: <span>c</span>
```

### 7.3 Alternate Description (Alt)

**For Figure or Formula elements:**
- If Alt key exists → Use as `alt` attribute on `<img>` or `<figure>`

**Example:**
```html
<figure><img alt="six-point star" src="star.jpg"/></figure>
```

### 7.4 Expansion Text (E)

**Processing:**
1. Create `<abbr>` element
2. Set `title` attribute to E value (UTF-8 encoded)
3. Use original content as abbr content

**Example:**
```
PDF: <Span E="Doctor">{Dr.}
HTML: <span><abbr title="Doctor">Dr.</abbr></span>
```

### 7.5 Pronunciation Hints (PDF 2.0)

**Processing:**
1. Preserve pronunciation hints on the derived element using `data-pdf-pronunciation` attributes.
2. Do not change visible text content.
3. If the output environment supports SSML/PLS, processors MAY emit equivalent SSML `<phoneme>` markup instead of (or in addition to) the data attributes.

**Example:**
```html
<span data-pdf-pronunciation="tSAt">chat</span>
```

---

## 8. Attribute Processing

### 8.1 Processing Priority

Attributes processed in order:
1. List attributes
2. Table attributes
3. Layout attributes
4. HTML attributes (O begins with "HTML-")
5. CSS attributes (O begins with "CSS-")
6. ARIA attributes (O begins with "ARIA-")

For PDF 2.0, treat owner names such as `HTML-1.00`, `CSS-1.00`, `CSS-2.00`, and `ARIA-1.00` as HTML/CSS/ARIA attribute owners.

### 8.2 Output Formats

**HTML Attributes:**
- Dictionary key → HTML attribute name
- Dictionary value → HTML attribute value

**CSS Properties:**
- Dictionary key → CSS property name
- Dictionary value → CSS property value
- Concatenate all CSS declarations into `style` attribute

### 8.3 List Attributes

**ListNumbering Attribute:**

| Value | HTML Output |
|-------|-------------|
| Ordered | `<ol>` |
| Unordered | `<ul>` |
| Description | `<dl>` |

**Ignored Attributes:**
- ContinuedList
- ContinuedFrom

### 8.4 Table Attributes

#### 8.4.1 HTML Attributes

| PDF Attribute | HTML Attribute | Notes |
|---------------|----------------|-------|
| ColSpan | `colspan` | Column span |
| RowSpan | `rowspan` | Row span |
| Headers | `headers` | References to header IDs |
| Scope | `scope` | Header scope |
| Short | `abbr` | Abbreviated text |

#### 8.4.2 CSS Properties

| PDF Attribute | CSS Property | Notes |
|---------------|--------------|-------|
| TBorderStyle | `border-style` | Convert to lowercase |
| TPadding | `padding` | Convert to pixels |

### 8.5 Layout Attributes

#### 8.5.1 Special Mappings

**Placement:**
- Block/Inline → `display: block` or `display: inline`
- Before/Start/End → `float: left` or `float: right`

**TextPosition:**
- Sup → Map element to `<sup>` (if not already a Sup-equivalent structure type)
- Sub → Map element to `<sub>` (if not already a Sub structure type)

#### 8.5.2 CSS Property Mappings

| PDF Attribute | CSS Property | Conversion |
|---------------|--------------|------------|
| WritingMode | `writing-mode` | Convert PDF names to CSS values |
| BackgroundColor | `background-color` | Convert to RGB |
| BorderColor | `border-color` | Convert to RGB |
| BorderStyle | `border-style` | Convert to lowercase |
| BorderThickness | `border-width` | Convert to pixels |
| Padding | `padding` | Convert to pixels |
| Color | `color` | Convert to RGB |
| SpaceBefore | `display` + `margin-top` | Interpreted |
| SpaceAfter | `display` + `margin-bottom` | Interpreted |
| StartIndent | `display` + `margin-left` | Interpreted |
| EndIndent | `display` + `margin-right` | Interpreted |
| TextIndent | `text-indent` | Convert to pixels |
| TextAlign | `text-align` | Convert values |
| LineHeight | `line-height` | Convert values |
| BaselineShift | `baseline-shift` | Convert to pixels |
| TextDecorationColor | `text-decoration-color` | Convert to RGB |
| TextDecorationType | `text-decoration` | LineThrough → line-through |
| RubyAlign | `ruby-align` | Convert values |
| RubyPosition | `ruby-position` | Convert values |

---

## 9. Content Processing

### 9.1 Content Types

PDF structure elements can contain:
- **Text**: Unicode text content
- **Paths**: Vector graphics
- **Image XObjects**: Raster images
- **Inline Images**: Embedded raster images
- **Form XObjects**: Grouped content
- **Shadings**: Gradient fills
- **Marked Content Sequences**: Metadata-annotated content

### 9.2 Text Content

**Processing:**
1. Convert text to UTF-8 encoding (PDF 2.0 allows UTF-8 strings in addition to UTF-16)
2. Output as HTML element content

### 9.3 Paths (Vector Graphics)

**Options:**
1. **Rasterize** → Convert to image (see 9.4)
2. **Convert to SVG** → Embed directly or via `<img>`
3. **Convert to Canvas** → Use HTML5 canvas element
4. **Ignore** → If irrelevant to reuse

### 9.4 Images

**Output:**
```html
<img src="[URL]" width="[W]" height="[H]"/>
```

**Width/Height Calculation:**
- Display size at 100% zoom
- Assume arm's length viewing distance (28 inches / 0.712m)
- 1 pixel = 1/96 inch at this distance

**Image Conversion:**
- Choose appropriate format: JPEG, PNG, GIF, SVG
- Consider: bit depth, color appearance, compression, masking
- For ImageMask images: Apply current color and masking
- If conversion fails: Use placeholder of same dimensions

**URL:**
- Implementation-dependent
- Can be absolute, relative, or data URL (RFC 2397)

### 9.5 Form XObjects

**Processing:**
- Process as grouping element
- Recursively process each child element per Section 9

### 9.6 Shadings

**Options:**
1. **Rasterize** → Convert to image (see 9.4)
2. **Vector** → Process as path (see 9.3)
3. **Ignore** → If irrelevant to reuse

### 9.7 Marked Content Sequences

#### 9.7.1 Lang Attribute
```html
<span lang="[LANG]">content</span>
```

#### 9.7.2 ActualText Attribute
- Replace content with ActualText value
- Wrap in `<span>`

#### 9.7.3 Alt Attribute
```html
<span alt="[ALT]">content</span>
```

#### 9.7.4 E (Expansion) Attribute
```html
<abbr title="[EXPANSION]">content</abbr>
```

#### 9.7.5 Multiple Attributes
- Create single `<span>` element
- If E attribute present: Nest `<abbr>` inside `<span>`

---

## 10. Widget Annotations (Interactive Forms)

### 10.1 Form Container

**HTML Structure:**
```html
<body>
  <!-- Document content -->
  <form name="acroform" id="acroform"></form>
</body>
```

**Form Field Reference:**
```html
<input name="FirstName" form="acroform"/>
```

### 10.2 Widget Mappings

#### 10.2.1 Button Elements

| PDF Field Type | HTML Element | type Attribute | Additional |
|----------------|--------------|----------------|------------|
| Push button | `<button>` | `button` | Inner HTML from appearance |
| Submit button | `<button>` | `submit` | Map URL to `formaction`, method to `formmethod` |
| Reset button | `<button>` | `reset` | - |

#### 10.2.2 Input Elements

| PDF Field Type | HTML Element | type Attribute | Additional Processing |
|----------------|--------------|----------------|----------------------|
| Check box | `<input>` | `checkbox` | Map Opt or appearance name to `value`; set `checked` if AS ≠ Off |
| Radio button | `<input>` | `radio` | Map Opt or appearance name to `value`; set `checked` if AS ≠ Off |
| Single line text | `<input>` | `text` | Map V to `value`, MaxLen to `maxlength`, DoNotSpellCheck to `spellcheck` |
| Password field | `<input>` | `password` | Map V to `value`, MaxLen to `maxlength` |
| File select | `<input>` | `file` | Map V to `value`, MaxLen to `maxlength` |
| Choice with Edit | `<input>` | `text` | Add `list` attribute + sibling `<datalist>` with options |

#### 10.2.3 Textarea Element

| PDF Field Type | HTML Element | Processing |
|----------------|--------------|------------|
| Multiline text | `<textarea>` | Map MaxLen to `maxlength`; inner HTML from RV (if RichText) or V |

#### 10.2.4 Select Element

| PDF Field Type | HTML Element | Additional Processing |
|----------------|--------------|----------------------|
| ListBox | `<select>` | Set `size="3"`; map Opt to `<option>` elements; map V and I to `selected` |
| Combo | `<select>` | Map Opt to `<option>` elements; map V and I to `selected` |

### 10.3 Widget Attributes

**CSS Styling (as `style` attribute):**
- Highlighting mode (H)
- Border style (BS)
- Border color (BC in MK)
- Background color (BG in MK)
- Text alignment (Q)

**HTML Attributes:**
- `readonly` ← ReadOnly flag (Ff)
- `required` ← Required flag (Ff)
- `name` ← Fully qualified field name

**Generated ID:**
- Unique identifier for each widget
- Used by `<label for="...">` in PDF 2.0 forms

### 10.4 Visibility

**Hidden Fields:**
- Invisible, Hidden, zero width/height, outside CropBox/MediaBox
- CSS: `display: none;`

---

## 11. ECMAScript/JavaScript

### 11.1 Objective

Achieve equivalent interactive experience in HTML as in PDF viewer.

### 11.2 Implementation Approach

**Recommended:**
1. Develop JavaScript library implementing ECMAScript for PDF objects
2. Provide implementations of:
   - `app` object (application)
   - `Doc` object (document)
   - `Field` objects (form fields)
   - `event` object (event handling)

### 11.3 Key Objects

#### 11.3.1 App Object

**Minimal Implementation:**
```javascript
var app = {
  viewerVersion: 1,
  viewerType: "Derivation",
  response: function() { return null; },
  beep: function(b) { },
  alert: function(msg) { window.alert(msg); }
};
```

#### 11.3.2 Field Objects

**Strategy:**
- Create Field object per HTML form field (lazy initialization)
- Maintain array of all fields
- Field changes update all HTML elements with same name

**Initialization:**
```javascript
function _init() {
  var elems = document.getElementsByTagName("input");
  for (var i = 0; i < elems.length; i++) {
    e.addEventListener("focus", field_event);
    e.addEventListener("change", field_event);
    e.addEventListener("click", field_event);
    all_fields.push(elems[i]);
  }
  do_calculations();
}
```

### 11.4 Script Inclusion

**Document-Level Scripts:**
- Extract from JavaScript entry in Names dictionary
- Include in derived HTML

**Page-Level Scripts:**
- Extract from AA entry in page dictionary
- Include in derived HTML

**Field-Level Scripts:**
- Extract from form field's additional-actions dictionary (AA)
- Generate unique function names based on field ID
- Attach to appropriate HTML events

**Calculation Order:**
- Maintain array of calculated fields
- Process in dependency order

---

## 12. Associated Files

### 12.1 Overview

PDF structure elements may reference external or embedded files to:
- Replace default HTML output (AFRelationship = Alternative)
- Supplement default HTML output (AFRelationship = Supplement)

PDF 2.0 formalizes associated files for general PDF usage; processors SHOULD preserve AFRelationship semantics when mapping to HTML.

### 12.2 File Types

**URL References:**
- FS key = URL
- No EF entry
- URL prohibits file:// scheme (local files)

**Embedded Files:**
- EF entry present
- Content embedded in PDF

### 12.3 Media Type Determination

**URL References:**
- Use filename extension + Table 9 mapping

**Embedded Files:**
- Use Subtype key of embedded file stream dictionary

### 12.4 Supported Media Types

| Media Type | Extensions | Purpose |
|------------|------------|---------|
| text/html, application/xhtml+xml | .htm, .html, .xhtml | HTML/XHTML fragments |
| text/css | .css | CSS stylesheets |
| text/javascript, application/javascript | .js | JavaScript code |
| image/jpeg, image/png, image/gif | .jpg, .png, .gif | Raster images |
| image/svg+xml | .svg | Vector graphics |
| application/mathml+xml | .xml, .mathml | Mathematical notation |

### 12.5 Processing by Media Type

#### 12.5.1 HTML/XHTML

**URL Reference:**
```html
<link rel="import" href="[URL]"/>
```

**Embedded File:**
- Insert content directly into HTML stream
- Replaces structure element
- Expected to be valid HTML fragment (not complete document)

#### 12.5.2 CSS

**Both types:**
```html
<style>@import url([URL]);</style>
```
- Insert immediately before referencing HTML element

#### 12.5.3 JavaScript

**Both types:**
```html
<script src="[URL]"></script>
```
- Insert immediately after referencing HTML element's closing tag
- MAY be implemented (security considerations)

#### 12.5.4 Images

**Both types:**
```html
<img src="[URL]"/>
```

#### 12.5.5 SVG

**Both types:**
```html
<img src="[URL]" width="[W]" height="[H]"/>
```
- Width/height from BBox structure attribute if present

#### 12.5.6 MathML

**Embedded File:**
- Insert content directly into HTML
- Replaces structure element
- May require polyfills for browser compatibility

---

## 13. Ensuring Valid HTML

### 13.1 Challenge

PDF allows structures that have no direct HTML equivalent or would produce invalid HTML.

### 13.2 Strategies

#### 13.2.1 Invalid Nesting

**Example: Heading in Table Cell**
```
PDF: <TH> <H1> {content}
Invalid HTML: <th><h1>content</h1></th>
Valid HTML: <th><p>content</p></th>
```

**Rule:** Map disallowed child elements to `<p>` or `<div>` as appropriate

#### 13.2.2 Structural Mismatches

**Example: Table in Caption**
```
PDF: <Caption> <Table> {...}
Invalid HTML: <caption><table>...</table></caption>
```

**Options:**
1. Move nested table outside parent
2. Map all elements to `<span>` (preserves visual)

#### 13.2.3 List in Paragraph

**Strategy:**
1. Close HTML elements until reaching parent allowing lists
2. Insert list at that level
3. Recreate structure for following siblings

---

## 14. Security Considerations

### 14.1 Risks

**Potential Vulnerabilities:**
- Embedded JavaScript accessing page/cookies
- Malicious HTML injection
- Cross-site scripting (XSS)
- Resource exhaustion

### 14.2 Mitigation Strategies

**For Public Services (User-Uploaded PDFs):**
1. **Sandboxing:** Process in isolated environment
2. **Content Filtering:** Strip/sanitize embedded scripts
3. **CSP Headers:** Implement Content Security Policy
4. **Validation:** Verify PDF structure before processing
5. **Limits:** Impose resource constraints

**For Controlled Environments:**
- Lower risk if processor controls both PDF source and HTML viewer
- Still apply defense-in-depth principles

### 14.3 Associated Files

**Specific Risks:**
- HTML namespace allows direct element injection
- JavaScript can execute arbitrary code
- URL references could point to malicious external resources

**Recommendations:**
- MAY ignore JavaScript associated files
- MAY restrict HTML namespace usage
- Validate URLs before fetching

---

## 15. Implementation Guidance

### 15.1 Development Approach

**Recommended Architecture:**
1. **Parser**: Read PDF structure tree
2. **Mapper**: Apply role mapping and element selection
3. **Attribute Processor**: Handle PDF attributes → HTML/CSS
4. **Content Processor**: Handle text, images, graphics
5. **Form Processor**: Convert widget annotations
6. **Script Processor**: Derive ECMAScript to JavaScript
7. **Output Generator**: Produce valid HTML5 and CSS

### 15.2 Testing Strategy

**Test Categories:**
1. **Structure Mapping:** All standard structure elements
2. **Special Cases:** Edge cases from Section 6
3. **Attributes:** All standard attributes and owners
4. **Forms:** All widget types and interactions
5. **Content:** Images, paths, shadings, XObjects
6. **Associated Files:** All media types
7. **Validity:** HTML5 validation
8. **Accessibility:** WCAG compliance (if applicable)

### 15.3 Performance Optimization

**Considerations:**
- Lazy initialization of Field objects
- Stream-based output for large documents
- Cached image conversion
- Parallel processing of independent elements

### 15.4 Error Handling

**Graceful Degradation:**
- Unknown structure types → Map to `<div>` or `<span>`
- Unsupported features → Omit or use placeholder
- Invalid nesting → Apply fix-up rules from Section 13
- Conversion failures → Log error and continue

---

## 16. Conformance

### 16.1 Processor Requirements

A **conforming processor** SHALL:
1. Accept well-tagged PDF as input (ISO 32000-2 §14.8 or PDF/UA-1)
2. Produce syntactically valid HTML5
3. Follow all normative requirements (SHALL/SHALL NOT)
4. Implement all structure element mappings
5. Process attributes according to priority order
6. Handle all special cases

A conforming processor MAY:
1. Support additional structure elements
2. Support additional attributes
3. Ignore JavaScript/associated files (with justification)
4. Apply additional transformations (documented)

### 16.2 Testing

Conformance tested by:
1. **Input Validation:** Verify PDF is well-tagged
2. **HTML Validation:** Use W3C validator
3. **Visual Comparison:** Compare PDF rendering to HTML
4. **Accessibility Testing:** Check ARIA/semantic preservation
5. **Interactive Testing:** Verify form behavior

---

## 17. References

### 17.1 Normative References

- **ISO 32000-2:2020**: PDF 2.0 specification
- **ISO/TS 32005:2023**: Interoperability guidance for PDF 1.7 and PDF 2.0 namespaces
- **ISO 14289-1**: PDF/UA-1 (Universal Accessibility)
- **ISO/IEC 16262:2011**: ECMAScript Language Specification
- **ISO 21757-1**: ECMAScript for PDF
- **HTML5**: http://www.w3.org/TR/html5/
- **CSS**: https://www.w3.org/Style/CSS/
- **RFC 1738**: Uniform Resource Locators (URL)
- **RFC 2397**: Data URL scheme

### 17.2 Informative References

- **Tagged PDF Best Practice Guide**: PDF Association
- **Matterhorn Protocol**: PDF/UA validation checkpoints
- **W3C Pronunciation Lexicon Specification (PLS)**: Pronunciation hint format
- **MathML**: https://www.w3.org/TR/MathML/

---

## Appendices

### Appendix A: Complete Element Mapping Table

See Section 5.2 for full mapping table of 50+ PDF structure elements to HTML5 elements.

### Appendix B: Attribute Mapping Tables

See Section 8 for complete mapping tables of:
- List attributes
- Table attributes (2 tables)
- Layout attributes (20+ mappings)

### Appendix C: Form Field Mappings

See Section 10.2 for complete mapping tables of 15+ form field types to HTML form elements.

### Appendix D: Example Conversions

Available in source specification document with numerous before/after examples.

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2019-06 | Initial specification by PDF Association |
| 1.1 | 2026-01-31 | Added PDF 2.0 namespaces, tag set updates, pronunciation hints, document parts, and associated file guidance |

---

## License

This specification is based on work © 2019 PDF Association, licensed under CC-BY-4.0.

Original document: "Deriving HTML from PDF" - PDF Association Specification 1.0 (2019-06)

---

**END OF SPECIFICATION**
