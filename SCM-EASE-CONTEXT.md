# SCM Ease — Complete Project Context for AI

> **Read this file first** before making any code changes. It tells you everything about the project.
> For detailed flowcharts with column-by-column data mappings, see `SCM-EASE-FLOWCHART.md`.
> Last updated: 2026-06-22

---

## 1. What Is SCM Ease? (Plain English)

A **solar panel factory supply chain tool**. It answers: "Do we have enough raw materials in our warehouse to build all the solar panels our customers ordered?"

It works in 3 steps:
1. Define what materials each panel type needs (Calc tab — the "recipe")
2. Upload customer orders from Excel + upload warehouse stock from Excel (Planning tab)
3. The app does the math and shows shortages (Planning tab results)

**Live URL**: GitHub Pages from repo `sohildobariya31-blip/scm-ease`
**Backend API**: Cloudflare Worker at `https://scm-ease-admin.scm-ease.workers.dev`

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  index.html  (~9000 lines, single SPA)                   │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ │
│  │ Calc │ │ Plan │ │ Cell │ │Vendor│ │ 3D   │ │Admin │ │
│  │ Tab  │ │ Tab  │ │ INV  │ │ Tab  │ │ Expl │ │Log/  │ │
│  │      │ │      │ │ Tab  │ │      │ │      │ │Users │ │
│  └──┬───┘ └──┬───┘ └──────┘ └──────┘ └──────┘ └──────┘ │
│     │        │                                           │
│     ▼        ▼                                           │
│  modules[] ──────────► runAnalysisAuto()                 │
│  (BOM data)            (planning engine)                 │
└────────────────────────┬─────────────────────────────────┘
                         │ API calls
                         ▼
┌──────────────────────────────────────────────────────────┐
│  scm-worker/worker.js  (Cloudflare Worker)               │
│  ├─ JWT auth (HMAC-SHA256)                               │
│  ├─ KV Storage (env.LOGS binding)                        │
│  │   ├─ activity_log         (activity history)          │
│  │   ├─ app_users            (user credentials)          │
│  │   ├─ user_permissions     (per-user tab perms)        │
│  │   ├─ customer_mappings_data (stock mappings)          │
│  │   ├─ consumption_defaults (saved default modules)     │
│  │   └─ planning_config      (customer overrides) [NEW]  │
│  └─ GitHub API (deploy changes to index.html)            │
└──────────────────────────────────────────────────────────┘
```

---

## 3. File Structure

```
scm-ease/
├── index.html           # Full SPA: HTML + CSS + JS (~9000 lines)
├── 3d-explorer.html     # 3D module visualizer (loaded in iframe)
├── sitemap.xml           # SEO
├── robots.txt            # SEO
├── google*.html          # Google verification
├── SCM-EASE-CONTEXT.md   # THIS FILE — AI context
├── SCM-EASE-FLOWCHART.md # Data flow diagram
└── scm-worker/
    ├── worker.js         # Cloudflare Worker API (~450 lines)
    ├── wrangler.toml     # Worker config (KV binding: LOGS)
    └── package.json      # Worker deps
```

---

## 4. Authentication & Users

| Role | Login Flow | Token | Capabilities |
|------|-----------|-------|-------------|
| **Gate User** | Name + Password → POST /api/verify-user | sessionStorage `siteUser` | Access tabs per permissions |
| **Admin** | ID (31122000) + Password → POST /api/login | JWT in sessionStorage `adminToken` | All tabs + Log + Users + Deploy |
| **Vendor User** | Auto from gate login (or vendor tab login) | sessionStorage `vendorUser` | Edit vendor data (if vendor_edit perm) |

**Permission system**: Admin sets per-user permissions via Users tab → Permissions sub-tab.
Keys: `calc`, `plan`, `plan_edit`, `cell`, `vendor`, `vendor_edit`, `explorer`
Stored in KV key `user_permissions` as `{ "username_lowercase": { calc: true, plan: false, ... } }`

---

## 5. Tab Details & Data Flow

### 5.1 Calculator (Consumption) Tab — `#calcMain`

**Purpose**: Define Bill of Materials (BOM) per solar module type.

**Data Model**:
```javascript
baseModules = [
  {
    key: "m10r",           // Module type ID
    name: "M10R Topcon",   // Display name
    rows: [                // 20-30 material rows per module
      {
        sr: 1,
        group: "Solar Cell",
        spec: "TopCon Crystalline 182.2 x 183.75 mm, M10R- 16 BB",
        uom: "Nos",
        qty: 72,            // Quantity per 1 module
        wastage: 1.5,       // Wastage percentage
        consumption: 73.08  // = qty × (1 + wastage/100)
      }
    ]
  },
  { key: "g12r", name: "G12R Topcon", rows: [...] },
  { key: "m10", name: "M10 Mono PERC", rows: [...] }
]
```

**State** (localStorage key: `rmConsv2`):
- `modules[]` — Current BOM (editable copy of baseModules)
- `moduleQty{}` — { m10r: 1000, g12r: 500, m10: 0 } — how many of each to build
- `moduleWp{}` — Module wattage per type
- `rowOverrides{}` — Per-row required qty overrides: `{ "m10r:0": 75000 }`
- `rowGeneration{}` — Per-row generation input: `{ "m10r:0": { value: 10, unit: "MW" } }`
- `rowPricing{}` — Per-row price input: `{ "m10r:0": { price: 2.5, currency: "USD", priceUom: "Nos" } }`
- `currencyRates` — { USD: 83.50, RMB: 11.50 }

**Key Functions**:
- `render()` — Main render loop, calculates all consumption values
- `renderTable()` — Renders BOM table with editable cells
- `renderControls()` — Module cards with qty/generation inputs
- `saveState()` — Persist to localStorage
- `consumption(qty, wastage)` = qty × (1 + wastage/100)

**Flow**: User adjusts module qty → render() recalculates all row consumption → saveState()

### 5.2 Planning Tab — `#planningMain`

**Purpose**: Upload Excel planning/stock sheets → auto-analyze material requirements → identify shortages.

**Input Files**:
1. **Production Planning Sheet** (.xlsx) — Columns: Customer Name | OA No, Line-X | Module Wp | Order Qty | Total MW | Date1 | Date2 | ...
2. **Store Stock Report** (.xlsx) — Columns: Category | SubCat | ItemNo | Description | VariantCode | VariantName | Location | LotNo | Quantity | UOM | Value

**Processing Pipeline** (function `runAnalysisAuto()`):

```
Step 1: Parse Planning Excel
  ├─ Find headers ("Customer Name" in col 0)
  ├─ Extract production line from col 1 (Line-A/B/C/D, OEM)
  ├─ Parse dates from cols 5+ (serial numbers or text)
  ├─ For each data row:
  │   ├─ oaDesc = col 1 (e.g., "Topcon G to G-OA/26-27/013T")
  │   ├─ wp = Number(col 2)
  │   ├─ Sum quantities in date range from cols 5+
  │   └─ detectModuleType(oaDesc, wp) → module key
  └─ Result: customerOrders[]

Step 2: Parse Stock Excel
  ├─ Auto-detect columns (Description, Qty, UOM, Location, Variant)
  ├─ Exclude rejection locations
  ├─ Aggregate by description + track variants
  └─ Result: aggregatedStock{}

Step 3: Aggregate planned modules
  └─ plannedModules = { m10r: { qty: 5000, wpValues: [595] }, g12r: { qty: 8000, ... } }

Step 4: Build consolidated materials
  ├─ For each planned module type:
  │   ├─ Look up module in modules[] (from consumption tab)
  │   ├─ For each BOM row: requiredQty = consumption × plannedQty
  │   └─ Merge same materials across module types
  └─ Result: consolidated{} keyed by "group|||spec"

Step 5: Map stock to materials
  ├─ buildAutoStockMapping() — keyword + dimension matching
  ├─ Apply user overrides (stockMappingOverrides, customerStockMappings)
  ├─ Calculate: diff = stockAvailable - requiredQty
  └─ Status: ok | low | short | discarded

Step 6: Render views
  ├─ Customer Orders table
  ├─ Customer Materials mapping
  ├─ Module Summary
  ├─ Consolidated Materials (with stock mapping UI)
  ├─ Detailed Breakdown
  └─ Stock Capacity analysis
```

**State** (localStorage key: `rmPlanOverrides`):
- `stockMappingOverrides{}` — Manual stock-to-material mappings
- `stockVariantSelections{}` — Selected variants per stock item
- `discardedMaterials` — Set of material keys to ignore
- `customerStockMappings{}` — Per-customer stock mappings
- `customerVariantSelections{}` — Per-customer variant selections

**State** (IndexedDB: `scmEaseDB`):
- `rmAnalysisState` — Full analysis results (lastAnalysis, aggregatedStock, planSheetName, dates)
- `rmRawData` — Raw Excel data (planRaw, stockRaw, planFmt) for re-analysis

**Key module-type detection** (`detectModuleType(oaDesc, wp)`):
- "topcon" + "g to g" → m10r (Wp<600) or g12r (Wp≥600)
- "topcon" alone → m10r or g12r by Wp
- "mono bifacial" → m10
- "monofacial" → m10
- "bifacial" → m10
- Wp 400-599 fallback → m10
- Wp ≥ 600 fallback → g12r
- **M10R range**: 580-600 Wp (Topcon, smaller cell size 182mm)
- **G12R range**: 600+ Wp (Topcon, larger cell size 210mm)
- **M10 range**: 400-579 Wp (Mono PERC, older technology)

### 5.3 Cell INV Tab — `#cellInvMain`

**Purpose**: Cell inventory pricing calculator. Editable table for solar cell pricing with USD/INR conversion.

**Key Functions**: `cellRenderTable()`, `cellAddRow()`, `cellDeleteRow()`
**State**: localStorage key `cellInvData`

### 5.4 Vendor Tab — `#vendorMain`

**Purpose**: Vendor price management with editable spreadsheet-like table.

**Auth**: Requires vendor login (auto from gate). Edit mode controlled by `body.vendor-edit-active` CSS class.
**Edit controls** (hidden when view-only): `.v-edit-only` elements — add row, add column, delete, drag handles.
**Data**: Saved to Cloudflare KV, loaded by `initVendorSheet()`.
**Key Functions**: `initVendorSheet()`, `vendorShowLogin()`, `updateAuthUI()`, `vendorAddRow()`, `vendorAddCol()`

### 5.5 3D Explorer Tab — `#explorerMain`

Loads `3d-explorer.html` in an iframe. Unloads when leaving tab (GPU/CPU optimization).

### 5.6 Admin Tabs (Log + Users)

**Log Tab** (`#logMain`): Activity log viewer. GET /api/logs.
**Users Tab** (`#usersMain`): User management + permissions matrix.
- Sub-tab "Users": Add/edit/delete users
- Sub-tab "Permissions": 8-column toggle matrix (calc, plan view, plan edit, cell, vendor view, vendor edit, explorer)

---

## 6. API Endpoints (worker.js)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/login | None | Admin login → JWT |
| POST | /api/verify-user | None | Gate user login |
| POST | /api/gate-login | None | Log gate login event |
| POST | /api/save | JWT | Deploy baseModules to GitHub |
| POST | /api/forgot | None | Email admin credentials |
| POST | /api/forgot-request | None | Request credentials (name+selfie) |
| GET | /api/users | JWT | List all users |
| POST | /api/users/add | JWT | Add user |
| POST | /api/users/update | JWT | Change password |
| POST | /api/users/delete | JWT | Delete user + cleanup perms |
| GET | /api/permissions | JWT | Get all user permissions |
| POST | /api/permissions/update | JWT | Set user permissions |
| POST | /api/user-permissions | None | Get one user's permissions |
| GET | /api/logs | JWT | Get activity logs |
| POST | /api/log | JWT | Add log entry |
| GET | /api/customer-data | None | Get customer stock mappings |
| POST | /api/customer-data | None | Save customer stock mappings |
| GET | /api/consumption-defaults | None | Get saved default modules |
| POST | /api/consumption-defaults | JWT | Save consumption defaults |
| GET | /api/planning-config | None | Get customer module overrides |
| POST | /api/planning-config | JWT | Save customer module overrides |

**KV Keys**: `activity_log`, `app_users`, `user_permissions`, `customer_mappings_data`, `consumption_defaults`, `planning_config`

---

## 7. Storage Map

| Layer | Key | Contents | Scope |
|-------|-----|----------|-------|
| localStorage | `rmConsv2` | modules, moduleQty, moduleWp, rowOverrides, rowGeneration, rowPricing, currencyRates | Per-browser |
| localStorage | `rmPlanOverrides` | stockMappingOverrides, stockVariantSelections, discardedMaterials, customerStockMappings | Per-browser |
| localStorage | `cellInvData` | Cell INV table rows | Per-browser |
| sessionStorage | `siteUser` | Gate-logged-in username | Per-session |
| sessionStorage | `adminToken` | JWT token | Per-session |
| sessionStorage | `vendorUser` | Vendor tab username | Per-session |
| sessionStorage | `userPermissions` | Cached permissions JSON | Per-session |
| sessionStorage | `planEditPerm` | "1" or "0" | Per-session |
| sessionStorage | `vendorEditPerm` | "1" or "0" | Per-session |
| IndexedDB | `scmEaseDB.rmAnalysisState` | Full analysis results | Per-browser |
| IndexedDB | `scmEaseDB.rmRawData` | Raw Excel data | Per-browser |
| Cloudflare KV | `customer_mappings_data` | Customer stock mappings (shared) | Global |
| Cloudflare KV | `consumption_defaults` | Admin-saved default BOM | Global |
| Cloudflare KV | `planning_config` | Customer module overrides (shared) | Global |

---

## 8. Key Global Variables (Runtime)

```javascript
// Consumption tab
const modules = [...]       // Active BOM (editable copy of baseModules)
const moduleQty = {}        // Qty per module type
const moduleWp = {}         // Wp per module type
const rowOverrides = {}     // Per-row required qty override
const rowGeneration = {}    // Per-row generation input
const rowPricing = {}       // Per-row pricing
const currencyRates = {}    // USD, RMB rates
let activeModule = "all"    // Currently selected module filter

// Planning tab
let planRaw = []            // Raw planning Excel data (all sheets concatenated)
let planFmt = []            // Formatted planning Excel data
let stockRaw = []           // Raw stock Excel data
let lastAnalysis = null     // { customerOrders, plannedModules, consolidated }
let aggregatedStock = {}    // { itemDesc: { qty, uom, cat, subcat, variants, variantNames } }
let allSheetDates = []      // All dates from planning headers
let userDateFrom = null     // Date range filter start
let userDateTo = null       // Date range filter end
let activePlanView = 'customers'  // Current planning sub-view

// Stock mapping overrides
const stockMappingOverrides = {}      // { materialKey: [stockDesc1, ...] }
const stockVariantSelections = {}     // { "matKey|||stockDesc": [variant1, ...] }
const discardedMaterials = new Set()  // Material keys to ignore
const customerStockMappings = {}      // { customer: { matKey: [stockDesc1, ...] } }
const customerVariantSelections = {}  // { "cust|||matKey|||stockDesc": [variant1, ...] }
```

---

## 9. CSS Architecture

**Theme variables**: `--bg`, `--panel`, `--ink`, `--muted`, `--solar-1` (#25d19a green), `--solar-2` (#1a9e76), `--solar-3` (#0f6e52), `--danger` (#ef4444)

**Key CSS classes**:
- `.mode-btn` — Tab buttons in header
- `.admin-active` — Body class when admin logged in (shows admin-only elements)
- `.vendor-edit-active` — Body class when vendor edit allowed (shows `.v-edit-only` elements)
- `.status-badge.ok/.low/.short` — Stock status indicators
- `.module-card` — Consumption module type cards
- `.kpi` — KPI metric cards
- `.upload-zone` — File drop zones
- `.perm-toggle` / `.perm-slider` — Permission toggle switches

---

## 10. Deployment

1. **Frontend**: Push `index.html` to GitHub → GitHub Pages auto-deploys
2. **Backend**: `cd scm-worker && npx wrangler deploy` → Deploys to Cloudflare Workers
3. **Admin Deploy** (in-app): Admin edits consumption → "Deploy Changes" → worker.js commits updated `baseModules` to GitHub via API

---

## 11. Important Implementation Notes

- **Single HTML file**: ALL CSS, HTML, and JS is in `index.html`. No build system.
- **No framework**: Vanilla JS, no React/Vue/Angular.
- **IIFE pattern**: Most features are wrapped in `(function(){ ... })()` to avoid global scope pollution.
- **Script blocks**: Multiple `<script>` blocks, each for a feature area.
- **Inline styles**: Extensive use of inline styles in HTML.
- **Print support**: `@media print` rules for clean printing.
- **Responsive**: Mobile-friendly with flex/grid layouts.
- **Error handling**: Try-catch around API calls, silent fallback on network errors.
- **Data integrity**: Planning overrides saved to both localStorage (per-browser) and Cloudflare KV (shared).

---

## 12. Module Type System

| Key | Name | Cell Size | Wp Range | Technology |
|-----|------|-----------|----------|-----------|
| m10r | M10R Topcon | 182.2 × 183.75 mm | 580-600 | TopCon N-type |
| g12r | G12R Topcon | 210 × 210 mm | 600+ | TopCon N-type |
| m10 | M10 Mono PERC | 182 × 182 mm | 400-579 | Mono PERC P-type |

**Detection priority in `detectModuleType()`**:
1. "topcon" + "g to g"/"g-to-g"/"gtg" → check Wp ≥ 600 ? g12r : m10r
2. "topcon" alone → check Wp ≥ 600 ? g12r : m10r
3. "mono bifacial" / "mono perc" → m10
4. "monofacial" / "mono facial" → m10
5. "bifacial" / "bi facial" → m10
6. Wp fallback: 580-599 → m10r, 400-579 → m10, ≥ 600 → g12r
