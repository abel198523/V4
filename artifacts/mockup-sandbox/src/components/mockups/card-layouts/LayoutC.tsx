
const BINGO_HEADERS = ["B", "I", "N", "G", "O"];
const CARD_NUMS = [
  [12, 22, 40, 51, 71],
  [5, 29, 45, 58, 63],
  [8, 17, "★", 55, 68],
  [14, 24, 43, 60, 74],
  [3, 19, 38, 52, 66],
];

function MiniCard({ called, accent }: { called: boolean[]; accent: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 1.5, width: 115 }}>
      {BINGO_HEADERS.map(h => (
        <div key={h} style={{ background: accent + "55", color: accent, fontSize: 8, fontWeight: 700, textAlign: "center", padding: "2px 0", borderRadius: 2 }}>{h}</div>
      ))}
      {CARD_NUMS.flat().map((n, i) => {
        const isHit = called[i];
        const isFree = n === "★";
        return (
          <div key={i} style={{
            background: (isHit || isFree) ? accent + "44" : "rgba(255,255,255,0.05)",
            color: (isHit || isFree) ? "#fff" : "#64748b",
            fontSize: 7.5, textAlign: "center", padding: "2.5px 0",
            borderRadius: 2, fontWeight: isHit ? 700 : 400
          }}>
            {isFree ? <span style={{ color: "#fbbf24" }}>★</span> : n}
          </div>
        );
      })}
    </div>
  );
}

const hitA = Array(25).fill(false).map((_, i) => [0,1,5,6,12,18,19,24].includes(i));
const hitB = Array(25).fill(false).map((_, i) => [2,3,7,12,17,21,22].includes(i));

export function LayoutC() {
  return (
    <div style={{ width: 390, height: 760, background: "#0f1117", display: "flex", flexDirection: "column", fontFamily: "system-ui", color: "#fff", overflow: "hidden" }}>

      {/* Stats bar */}
      <div style={{ background: "#111827", padding: "6px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
        <div style={{ fontSize: 11, color: "#94a3b8" }}>💰 <span style={{ color: "#fbbf24", fontWeight: 700 }}>450 ETB</span></div>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#60a5fa" }}>⏱ 18</div>
        <div style={{ fontSize: 11, color: "#94a3b8" }}>👥 <span style={{ color: "#fff" }}>12</span></div>
      </div>

      {/* Main game body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        {/* Left: master grid */}
        <div style={{ flex: 1, padding: "8px 4px 8px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 2, marginBottom: 2 }}>
            {BINGO_HEADERS.map((h, i) => (
              <div key={h} style={{ background: ["#1e3a8a","#164e63","#14532d","#713f12","#4c1d95"][i], color: "#fff", textAlign: "center", fontSize: 10, fontWeight: 800, padding: "3px 0", borderRadius: 3 }}>{h}</div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 2, flex: 1 }}>
            {Array.from({ length: 75 }, (_, i) => {
              const called = [7,14,22,31,45,52,60,67,72,3,18].includes(i + 1);
              return (
                <div key={i} style={{
                  background: called ? "rgba(59,130,246,0.3)" : "rgba(255,255,255,0.04)",
                  border: called ? "1px solid #3b82f6" : "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 2, textAlign: "center", fontSize: 7, color: called ? "#93c5fd" : "#475569",
                  display: "flex", alignItems: "center", justifyContent: "center"
                }}>{i + 1}</div>
              );
            })}
          </div>
        </div>

        {/* Right: ball area */}
        <div style={{ width: 130, padding: "8px 8px 8px 4px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center" }}>
            {[7, 14, 22].map(n => (
              <div key={n} style={{ width: 22, height: 22, borderRadius: "50%", background: "#1e3a8a", color: "#93c5fd", fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{n}</div>
            ))}
          </div>
          <div style={{ width: 80, height: 80, borderRadius: "50%", background: "radial-gradient(circle at 35% 35%, #fcd34d, #d97706)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, fontWeight: 900, color: "#fff", boxShadow: "0 0 20px rgba(251,191,36,0.5)" }}>31</div>
          <div style={{ fontSize: 9, color: "#64748b" }}>Automatic</div>
          <div style={{ width: 44, height: 22, background: "#1d4ed8", borderRadius: 11, position: "relative" }}>
            <div style={{ width: 18, height: 18, background: "#fff", borderRadius: "50%", position: "absolute", top: 2, right: 2 }} />
          </div>
        </div>
      </div>

      {/* ── LAYOUT C: Both cards side-by-side strip at BOTTOM ── */}
      <div style={{
        background: "linear-gradient(135deg, rgba(30,58,138,0.25) 0%, rgba(76,29,149,0.2) 100%)",
        borderTop: "1px solid rgba(99,102,241,0.3)",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        padding: "8px 12px",
        display: "flex",
        gap: 12,
        justifyContent: "center",
        alignItems: "center",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 9, color: "#60a5fa", fontWeight: 800, letterSpacing: 1 }}>ካርድ 1</span>
          <MiniCard called={hitA} accent="#60a5fa" />
        </div>
        <div style={{ width: 1, background: "rgba(255,255,255,0.1)", alignSelf: "stretch" }} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 9, color: "#a78bfa", fontWeight: 800, letterSpacing: 1 }}>ካርድ 2</span>
          <MiniCard called={hitB} accent="#a78bfa" />
        </div>
      </div>

      {/* Bottom bar */}
      <div style={{ display: "flex", gap: 6, padding: "8px 10px", background: "#111827", borderTop: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
        <button style={{ flex: 1, background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, padding: "7px 0", fontSize: 11, fontWeight: 700 }}>Leave</button>
        <button style={{ flex: 1, background: "#f97316", color: "#fff", border: "none", borderRadius: 6, padding: "7px 0", fontSize: 11, fontWeight: 700 }}>Refresh</button>
        <button style={{ flex: 1, background: "#78570a", color: "#fbbf24", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 6, padding: "7px 0", fontSize: 11, fontWeight: 700 }}>Automatic</button>
      </div>

      <div style={{ position: "absolute", bottom: 55, left: 0, right: 0, textAlign: "center", fontSize: 10, color: "#818cf8", fontWeight: 700, pointerEvents: "none" }}>
        ✦ አማራጭ C — ካርዶቹ ከታቸ ጎን ለጎን ✦
      </div>
    </div>
  );
}
