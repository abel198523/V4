
const BINGO_HEADERS = ["B", "I", "N", "G", "O"];
const CARD1 = [[12,22,40,51,71],[5,29,45,58,63],[8,17,"★",55,68],[14,24,43,60,74],[3,19,38,52,66]];
const CARD2 = [[9,20,35,50,70],[6,25,42,57,65],[11,16,"★",53,69],[13,28,44,59,73],[4,21,37,54,62]];
const HIT1 = new Set([0,1,5,6,12,18,19,24]);
const HIT2 = new Set([2,3,7,12,17,21,22]);

function PanelCard({ nums, hits, accent }: { nums: (number|string)[][]; hits: Set<number>; accent: string }) {
  const flat = nums.flat();
  return (
    <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:1.5, width:"100%" }}>
      {BINGO_HEADERS.map((h,i) => (
        <div key={h} style={{ background:["#1e3a8a","#4c1d95","#14532d","#713f12","#991b1b"][i], color:"#fff", fontSize:8, fontWeight:800, textAlign:"center", padding:"3px 0", borderRadius:2 }}>{h}</div>
      ))}
      {flat.map((n,i) => {
        const hit = hits.has(i);
        const free = n === "★";
        return (
          <div key={i} style={{
            background: (hit||free) ? accent+"44" : "rgba(255,255,255,0.06)",
            border: `1px solid ${(hit||free) ? accent : "rgba(255,255,255,0.08)"}`,
            color: (hit||free) ? "#fff" : "#64748b",
            fontSize:7, textAlign:"center", borderRadius:2, fontWeight: hit ? 700 : 400,
            padding:"3px 0"
          }}>
            {free ? <span style={{color:"#fbbf24"}}>★</span> : n}
          </div>
        );
      })}
    </div>
  );
}

export function LayoutD() {
  return (
    <div style={{ width:390, height:760, background:"#0f1117", display:"flex", flexDirection:"column", fontFamily:"system-ui", color:"#fff", overflow:"hidden" }}>

      {/* Stats bar */}
      <div style={{ background:"#111827", padding:"5px 10px", display:"flex", justifyContent:"space-between", borderBottom:"1px solid rgba(255,255,255,0.08)", flexShrink:0 }}>
        {[["Game ID","NOVA-24"],["Players","12"],["Bet","10 ETB"],["Derash","120"],["Called","18"]].map(([l,v])=>(
          <div key={l} style={{ textAlign:"center" }}>
            <div style={{ fontSize:8, color:"#64748b", fontWeight:700 }}>{l}</div>
            <div style={{ fontSize:11, fontWeight:800, color:"#e2e8f0" }}>{v}</div>
          </div>
        ))}
      </div>

      {/* ── Ball strip (compact horizontal) ── */}
      <div style={{ display:"flex", alignItems:"center", gap:6, padding:"5px 8px", background:"rgba(255,255,255,0.03)", borderBottom:"1px solid rgba(255,255,255,0.08)", flexShrink:0, minHeight:58 }}>
        {/* Recent balls */}
        <div style={{ flex:1, display:"flex", flexWrap:"wrap", gap:3, alignContent:"center" }}>
          {[7,14,22,31,45,52,60].map(n => (
            <div key={n} style={{ width:20, height:20, borderRadius:"50%", background:"rgba(59,130,246,0.3)", border:"1px solid #3b82f6", fontSize:8, display:"flex", alignItems:"center", justifyContent:"center", color:"#93c5fd", fontWeight:700 }}>{n}</div>
          ))}
        </div>
        {/* Big ball + active chip + mute */}
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2, flexShrink:0 }}>
          <div style={{ fontSize:8, background:"#1e3a8a", color:"#93c5fd", borderRadius:10, padding:"1px 8px", fontWeight:700 }}>B-67</div>
          <div style={{ width:38, height:38, borderRadius:"50%", background:"radial-gradient(circle at 35% 35%, #fcd34d, #d97706)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, fontWeight:900, color:"#fff", boxShadow:"0 0 14px rgba(251,191,36,0.5)" }}>67</div>
          <div style={{ color:"rgba(255,255,255,0.4)", fontSize:10 }}>🔊</div>
        </div>
        {/* Auto toggle */}
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:3, background:"rgba(255,255,255,0.05)", borderRadius:8, padding:"4px 6px", flexShrink:0, minWidth:48 }}>
          <span style={{ fontSize:8, fontWeight:700, color:"#e2e8f0" }}>Auto</span>
          <div style={{ width:36, height:18, background:"#22c55e", borderRadius:9, position:"relative" }}>
            <div style={{ width:14, height:14, background:"#fff", borderRadius:"50%", position:"absolute", top:2, right:2 }} />
          </div>
        </div>
      </div>

      {/* ── Main body: left=master grid, right=cards stacked ── */}
      <div style={{ flex:1, display:"flex", overflow:"hidden", minHeight:0 }}>

        {/* LEFT: master grid */}
        <div style={{ flex:1, padding:"6px 4px 6px 6px", display:"flex", flexDirection:"column", gap:3, minHeight:0 }}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:2 }}>
            {BINGO_HEADERS.map((h,i) => (
              <div key={h} style={{ background:["#1e3a8a","#4c1d95","#14532d","#713f12","#991b1b"][i], color:"#fff", textAlign:"center", fontSize:9, fontWeight:800, padding:"2px 0", borderRadius:2 }}>{h}</div>
            ))}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:2, flex:1 }}>
            {Array.from({length:75},(_,i) => {
              const c = [7,14,22,31,45,52,60,67,3,18,35,50,12,28,42].includes(i+1);
              return (
                <div key={i} style={{
                  background: c ? "rgba(239,68,68,0.28)" : "rgba(255,255,255,0.04)",
                  border: c ? "1px solid #f87171" : "1px solid rgba(255,255,255,0.06)",
                  borderRadius:2, textAlign:"center", fontSize:7, color: c ? "#fca5a5" : "#475569",
                  display:"flex", alignItems:"center", justifyContent:"center", fontWeight: c ? 700 : 400
                }}>{i+1}</div>
              );
            })}
          </div>
        </div>

        {/* RIGHT: cards stacked */}
        <div style={{ width:130, flexShrink:0, display:"flex", flexDirection:"column", padding:"6px 5px 6px 0", gap:0, minHeight:0, overflow:"hidden" }}>

          {/* Card 1 label */}
          <div style={{ fontSize:8, fontWeight:800, color:"#60a5fa", textAlign:"center", padding:"1px 0 3px", letterSpacing:0.6, flexShrink:0 }}>ካርድ 1</div>

          {/* Card 1 grid — takes top half */}
          <div style={{ flex:1, minHeight:0, overflow:"hidden" }}>
            <PanelCard nums={CARD1} hits={HIT1} accent="#3b82f6" />
          </div>

          <div style={{ fontSize:8, color:"#94a3b8", fontWeight:700, textAlign:"center", padding:"1px 0", flexShrink:0 }}>C-042</div>

          {/* Divider */}
          <div style={{ height:1, background:"rgba(255,255,255,0.1)", margin:"4px 0", flexShrink:0 }} />

          {/* Card 2 label */}
          <div style={{ fontSize:8, fontWeight:800, color:"#a78bfa", textAlign:"center", padding:"1px 0 3px", letterSpacing:0.6, flexShrink:0 }}>ካርድ 2</div>

          {/* Card 2 grid — takes bottom half */}
          <div style={{ flex:1, minHeight:0, overflow:"hidden" }}>
            <PanelCard nums={CARD2} hits={HIT2} accent="#8b5cf6" />
          </div>

          <div style={{ fontSize:8, color:"#94a3b8", fontWeight:700, textAlign:"center", padding:"1px 0", flexShrink:0 }}>C-078</div>
        </div>
      </div>

      {/* Bottom bar */}
      <div style={{ display:"flex", gap:6, padding:"7px 10px", background:"#111827", borderTop:"1px solid rgba(255,255,255,0.08)", flexShrink:0 }}>
        <button style={{ flex:1, background:"#ef4444", color:"#fff", border:"none", borderRadius:6, padding:"10px 0", fontSize:11, fontWeight:700 }}>Leave</button>
        <button style={{ flex:1, background:"#f97316", color:"#fff", border:"none", borderRadius:6, padding:"10px 0", fontSize:11, fontWeight:700 }}>↺ Refresh</button>
        <button style={{ flex:1, background:"#78570a", color:"#fbbf24", border:"1px solid rgba(245,158,11,0.3)", borderRadius:6, padding:"10px 0", fontSize:11, fontWeight:700 }}>Automatic</button>
      </div>
    </div>
  );
}
