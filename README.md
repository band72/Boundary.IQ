# Boundary.IQ — Survey Intelligence Platform

Boundary.IQ is a professional survey computing, legal description processing, and geometric mapping platform. It bridges the gap between historical land deeds, scanned plats, and digital CAD coordinates.

By combining a high-performance **C# ASP.NET Core geometry engine (RCS COGO)** with **Google Gemini 3.5 Flash** vision models and a glassmorphic **React/Vite frontend**, Boundary.IQ automates deed transcription, calculates mathematical closure, adjusts linear error, and drafts survey-grade legal descriptions.

---

## 🗺️ Core Modules

1. **📐 Traverse Compute (COGO Engine)**: Allows manual entry of coordinate geometry courses (Lines and Curves). It computes progressive station coordinates, assesses polygon closure, calculates perimeter and area, and applies the standard **Compass Rule** adjustment to eliminate linear errors.
2. **🛰️ Plat/Deed Extraction**: Utilizes Gemini 3.5 Flash to read scanned survey plats or deed PDF documents, extract the metes-and-bounds segment callouts, and transcribe them into raw JSON arrays instantly.
3. **✍️ Legal Description Writer**: Translates a sequence of coordinate geometry courses, Point of Beginning coordinates, and parcel metadata into professional, survey-grade legal descriptions ready for land registry.
4. **📦 Batch Deed Processor**: Processes up to 20 plat files or PDFs in parallel, extracting boundary courses, computing closure, drawing interactive maps, and generating legal descriptions in a unified, split-view pipeline.

---

## ⚡ Step-by-Step Tutorial: How to Solve and Map a Deed

Solving a land deed is the process of converting a written metes-and-bounds description (e.g., *"Thence North 45 degrees East 150 feet..."*) into high-accuracy coordinate stations $(N, E)$ and ensuring that the boundary forms a closed loop returning to the **Point of Beginning (POB)**.

### Case Study 1: Automatic OCR, Computation & Mapping of `2502.7 - WD.pdf`

Boundary.IQ has successfully OCRed, solved, and mapped the historical deed document `2502.7 - WD.pdf`.

#### 1. Ingesting & OCR
Uploading the PDF to the **Plat Extraction** tab triggers the Gemini 3.5 Flash vision processor. It scans the document's legal text and extracts the following **12 contiguous courses**:

| Course # | Segment Type | Bearing / Chord Bearing | Distance / Arc Length | Curve Radius | Delta / Direction |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | Line | $S 89^\circ 41' 10" W$ | $208.42'$ | — | — |
| **2** | Line | $S 00^\circ 18' 50" E$ | $40.98'$ | — | — |
| **3** | Line | $S 65^\circ 41' 40" W$ | $175.34'$ | — | — |
| **4** | Line | $S 55^\circ 41' 40" W$ | $165.00'$ | — | — |
| **5** | Line | $N 28^\circ 04' 20" W$ | $231.11'$ | — | — |
| **6** | Line | $S 89^\circ 41' 10" W$ | $898.00'$ | — | — |
| **7** | Line | $S 01^\circ 31' 15" E$ | $542.69'$ | — | — |
| **8** | Curve | $N 82^\circ 38' 46" W$ *(Chord)* | $1361.42'$ *(Arc)* | $5679.65'$ | $13.7338^\circ$ / Left |
| **9** | Line | $N 01^\circ 15' 03" W$ | $364.72'$ | — | — |
| **10** | Line | $N 01^\circ 15' 03" W$ | $1079.31'$ | — | — |
| **11** | Line | $N 89^\circ 45' 21" E$ | $2866.11'$ | — | — |
| **12** | Line | $S 00^\circ 18' 50" E$ | $1070.99'$ | — | — |

#### 2. Coordinate Geometry (COGO) Calculations
Assuming a standard Point of Beginning (POB) coordinate of **Northing 5000.00**, **Easting 5000.00**, the geometry engine projects the stations sequentially by calculating the Northing departure ($\Delta N$) and Easting departure ($\Delta E$) for each leg:
$$\Delta N = d \cdot \cos(\theta)$$
$$\Delta E = d \cdot \sin(\theta)$$

After projecting all 12 courses, the final coordinate lands at **Northing 5007.98**, **Easting 4996.81**.

#### 3. Analyzing the Closure Report
Because this is an unadjusted historical deed, the end of the 12th segment does not land exactly back at $(5000.00, 5000.00)$. Boundary.IQ audits this misclosure instantly:
* **Perimeter**: $9004.09\text{ feet}$
* **Linear Error of Closure**: $8.5959\text{ feet}$
* **Precision Ratio**: **$1:1,047$**
* **Calculated Area**: **$85.5973\text{ acres}$** ($3,728,618\text{ sq ft}$)

#### 4. Applying the Compass (Bowditch) Rule
To close the traverse perfectly for mapping and design, the engine distributes the misclosure error proportionally across all courses. 
The correction applied to the northing ($\delta N_i$) and easting ($\delta E_i$) of course $i$ is:
$$\delta N_i = - E_{\text{Northing}} \cdot \frac{d_i}{P}$$
$$\delta E_i = - E_{\text{Easting}} \cdot \frac{d_i}{P}$$
*Where $E$ is the raw coordinate error, $d_i$ is the distance of the course, and $P$ is the total perimeter.*

Applying this adjustment redistributes the $8.59'$ error smoothly, adjusting the final station coordinate perfectly back to **Northing 5000.00**, **Easting 5000.00**, producing a watertight, closed vector polygon.

---

### Case Study 2: The Perfect Traverse (Mathematical Verification)

To verify the mathematical precision of the engine, input the following perfect square traverse into the **Traverse Compute** tab:
1. **Course 1**: Type = `Line`, Bearing = `N00°00'00"E`, Distance = `100.00`
2. **Course 2**: Type = `Line`, Bearing = `N90°00'00"E` (or `East`), Distance = `100.00`
3. **Course 3**: Type = `Line`, Bearing = `S00°00'00"W`, Distance = `100.00`
4. **Course 4**: Type = `Line`, Bearing = `S90°00'00"W` (or `West`), Distance = `100.00`

#### Results:
* **Linear Error**: **$0.0000\text{ feet}$**
* **Precision Ratio**: **$1:\infty$ (Perfect Closure)**
* **Area**: **$10,000.00\text{ sq ft}$** ($0.2296\text{ acres}$)
* **Map Display**: A perfect square boundary that snaps cleanly to the point of beginning.

---

## 💻 Running the Application Stack

Boundary.IQ is designed for low-overhead local development.

### Prerequisites
* **Runtime**: .NET 8.0 SDK & Node.js (v18+)
* **Dependencies**: Dev packages for C# and React are pre-configured.

### Quick Start (Linux / macOS)

1. **Configure Environment Variables**:
   Create a `.env` file in the root directory and add your Google Gemini API key:
   ```env
   Gemini__ApiKey=YOUR_API_KEY_HERE
   ```

2. **Launch the C# Backend API**:
   ```bash
   cd api/BoundaryIQ.Api
   dotnet run --urls http://localhost:5050
   ```
   *The API will start hosting a Swagger document and endpoints on `http://localhost:5050`.*

3. **Launch the React Frontend**:
   ```bash
   cd client
   npm install
   npm run dev -- --port 5174
   ```
   *The Vite web interface will spin up at `http://localhost:5174`.*

4. **Access the Web Dashboard**:
   Open your browser and navigate to **`http://localhost:5174`**. Select the **Plat Extraction** or **Traverse Compute** tab to begin mapping!
