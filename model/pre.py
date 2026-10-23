import pandas as pd
from pathlib import Path

# ================= FILE PATHS =================
BASE_DIR = Path(__file__).parent

AREA_FILE = BASE_DIR / "District_FloodedArea.csv"
IMPACT_FILE = BASE_DIR / "District_FloodImpact.csv"
DFSI_FILE = BASE_DIR / "DFSI.csv"
RECENT_FILE = BASE_DIR / "recent_flood_2024_25.csv"

# ================= CLEAN =================
def clean(df):
    df.columns = [str(col).strip() for col in df.columns]
    df = df.drop_duplicates()
    num_cols = df.select_dtypes(include="number").columns
    df[num_cols] = df[num_cols].fillna(0)
    return df

# ================= PREPROCESS =================
def preprocess_all():
    area = clean(pd.read_csv(AREA_FILE))
    impact = clean(pd.read_csv(IMPACT_FILE))
    dfsi = clean(pd.read_csv(DFSI_FILE))

    dfsi.columns = ["Dist_Name", "State_Name", "DFSI"]

    merged = area.merge(impact, on="Dist_Name", how="outer")
    merged = merged.merge(dfsi, on="Dist_Name", how="left")

    # remove invalid names
    merged = merged.dropna(subset=["Dist_Name"])
    merged["Dist_Name"] = merged["Dist_Name"].astype(str).str.strip()
    merged = merged[merged["Dist_Name"].str.len() > 2]

    # IMPORTANT: DO NOT GROUP (keeps time variation)
    merged = merged.drop_duplicates()

    return merged

# ================= YEAR =================
def extract_year(df):
    df["Year"] = df.groupby("Dist_Name").cumcount() + 2015
    return df

# ================= MAIN =================
if __name__ == "__main__":

    print("Processing data...\n")

    merged = extract_year(preprocess_all())

    from sklearn.model_selection import train_test_split
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.metrics import accuracy_score

    X = merged.select_dtypes(include=["number"]).drop(columns=["DFSI"])
    y = (merged["DFSI"] > merged["DFSI"].mean()).astype(int)

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    rf = RandomForestClassifier(n_estimators=100, random_state=42)
    rf.fit(X_train, y_train)

    accuracy = accuracy_score(y_test, rf.predict(X_test)) * 100
    print("Model Accuracy:", f"{accuracy:.2f}%\n")

    # ================= RISK =================
    def classify(x):
        if x < merged["DFSI"].quantile(0.33): return "LOW"
        elif x < merged["DFSI"].quantile(0.66): return "MEDIUM"
        else: return "HIGH"

    merged["Risk_Level"] = merged["DFSI"].apply(classify)
    merged_sorted = merged.sort_values(by="DFSI", ascending=False)

    # ================= STATE =================
    state_risk = merged.groupby("State_Name")["DFSI"].mean().reset_index()
    state_risk["Risk_Level"] = state_risk["DFSI"].apply(classify)

    # ================= RECENT =================
    recent = pd.read_csv(RECENT_FILE)

    recent["DFSI"] = (
        recent["Deaths"] * 0.4 +
        recent["Population_Affected"] * 0.00001 +
        recent["Houses_Damaged"] * 0.001 +
        recent["Crop_Affected"] * 0.01
    )

    recent["Risk_Level"] = recent["DFSI"].apply(
        lambda x: "LOW" if x < recent["DFSI"].quantile(0.33)
        else "MEDIUM" if x < recent["DFSI"].quantile(0.66)
        else "HIGH"
    )

    # ================= TIME SERIES =================
    from statsmodels.tsa.arima.model import ARIMA

    ts = merged.groupby(["Dist_Name","Year"])["DFSI"].mean().reset_index()
    high_risk = merged[merged["Risk_Level"]=="HIGH"]["Dist_Name"].unique()

    future = []

    for d in high_risk:
        data = ts[ts["Dist_Name"]==d].sort_values("Year")

        try:
            if len(data) < 3:
                base = data["DFSI"].mean()
                forecast = [base + i*0.1 for i in range(5)]  # small trend
            else:
                series = data["DFSI"].values
                model = ARIMA(series, order=(1,1,1)).fit()
                forecast = model.forecast(5)

            years = [2026,2027,2028,2029,2030]

            for y,v in zip(years,forecast):
                future.append([d,y,round(v,2)])

        except:
            continue

    future_df = pd.DataFrame(future, columns=["District","Year","Predicted_DFSI"])

    print("========== FUTURE PREDICTIONS ==========")
    print(future_df.to_string(index=False))

    # ================= PDF =================
    from reportlab.platypus import *
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet

    doc = SimpleDocTemplate("Flood_Report.pdf")
    styles = getSampleStyleSheet()
    content = []

    def table_style(data):
        t = Table(data)
        style=[('BACKGROUND',(0,0),(-1,0),colors.grey),
               ('TEXTCOLOR',(0,0),(-1,0),colors.white),
               ('GRID',(0,0),(-1,-1),1,colors.black)]
        for i,row in enumerate(data[1:],1):
            if row[-1]=="HIGH": style.append(('BACKGROUND',(0,i),(-1,i),colors.red))
            elif row[-1]=="MEDIUM": style.append(('BACKGROUND',(0,i),(-1,i),colors.yellow))
            else: style.append(('BACKGROUND',(0,i),(-1,i),colors.lightgreen))
        t.setStyle(TableStyle(style))
        return t

    content.append(Paragraph("Flood Risk Report",styles["Title"]))
    content.append(Spacer(1,10))

    # Districts
    content.append(Paragraph("All District Risk Data", styles["Heading2"]))
    data=[["District","DFSI","Risk"]]
    for _,r in merged_sorted.iterrows():
        data.append([r["Dist_Name"],f"{r['DFSI']:.2f}",r["Risk_Level"]])

    for i in range(0,len(data),20):
        content.append(table_style(data[i:i+20]))
        content.append(PageBreak())

    # States
    content.append(Paragraph("State-wise Risk", styles["Heading2"]))
    data=[["State","DFSI","Risk"]]
    for _,r in state_risk.iterrows():
        data.append([r["State_Name"],f"{r['DFSI']:.2f}",r["Risk_Level"]])
    content.append(table_style(data))
    content.append(PageBreak())

    # Recent
    content.append(Paragraph("Recent Flood Risk", styles["Heading2"]))
    data=[["Region","DFSI","Risk"]]
    for _,r in recent.iterrows():
        data.append([r["Dist_Name"],f"{r['DFSI']:.2f}",r["Risk_Level"]])
    content.append(table_style(data))
    content.append(PageBreak())

    # Future
    if not future_df.empty:
        future_df["Risk"] = future_df["Predicted_DFSI"].apply(classify)

        content.append(Paragraph("Future Prediction (All High Risk Districts)", styles["Heading2"]))
        data=[["District","Year","DFSI","Risk"]]

        for _,r in future_df.iterrows():
            data.append([r["District"],r["Year"],r["Predicted_DFSI"],r["Risk"]])

        for i in range(0,len(data),25):
            content.append(table_style(data[i:i+25]))
            content.append(PageBreak())

    doc.build(content)

    print("\nPDF GENERATED SUCCESSFULLY")