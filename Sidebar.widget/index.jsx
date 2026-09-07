import { css, run, React } from "uebersicht";

// PONYTAIL MODE: Completely disable Ubersicht's built-in background polling.
// The widget will now ONLY execute shell commands when triggered by your 
// AeroSpace AppleScript callback (or on initial load).
export const refreshFrequency = false;

const screenWidth = window.screen.width;

// ponytail: Panel width stays fixed at 50px (matching aerospace outer.left gap).
const panelWidth = 50;

const options = {
  width: panelWidth + "px",
};

const FAST_CMD = `/opt/homebrew/bin/aerospace list-workspaces --focused 2>/dev/null; echo "---"; /opt/homebrew/bin/aerospace list-windows --all --format "%{monitor-name}|%{workspace}|%{app-name}" 2>/dev/null`;
const SLOW_CMD = `ifconfig en0 2>/dev/null; echo "---"; SideBar.widget/audio_device 2>/dev/null; echo "---"; pmset -g batt; echo "---"; networksetup -getairportpower en0 2>/dev/null; echo "---"; vm_stat 2>/dev/null; echo "---"; sysctl vm.swapusage hw.memsize 2>/dev/null`;

// In-memory icon cache to completely eliminate DOM image loading delays and onError thrashing
if (typeof window !== "undefined" && !window.statBarIconCache) {
  window.statBarIconCache = new Set();
  window.statBarPendingIcons = new Set();
  run(`ls SideBar.widget/icons 2>/dev/null`).then(res => {
    res.split('\n').forEach(f => window.statBarIconCache.add(f.replace('.png', '').trim()));
  });
}

// ponytail: Icon generation runs independently of dedup — checks app list against icon cache
// and generates missing icons regardless of whether the aerospace output string changed.
const ensureIcons = (monitors, dispatch) => {
  if (!monitors || !window.statBarIconCache) return;
  monitors.forEach(mon => {
    mon.apps.forEach(appObj => {
      const appName = appObj.name;
      if (!window.statBarIconCache.has(appName) && !window.statBarPendingIcons.has(appName)) {
        window.statBarPendingIcons.add(appName);
        const safeName = appName.replace(/"/g, '\\"');
        run(`SideBar.widget/generate_icon.sh "${safeName}"`).then(() => {
          window.statBarIconCache.add(appName);
          window.statBarPendingIcons.delete(appName);
          dispatch({ type: "ICON_LOADED" });
        });
      }
    });
  });
};

const handleFastOutput = (output, dispatch) => {
  if (window.statBarLastFast === output) return;
  window.statBarLastFast = output;
  try {
    const parts = output.split('---');
    const workspace = parts[0]?.trim() || "N/A";
    const windowsRaw = parts[1]?.trim() || "";
    const appsByMonitor = {};
    
    if (windowsRaw) {
      windowsRaw.split('\n').forEach(line => {
        const cols = line.split('|');
        if (cols.length > 2) {
          const mon = cols[0].trim();
          const ws = cols[1].trim();
          const app = cols[2].trim();
          if (app && app !== "Finder") {
            if (!appsByMonitor[mon]) appsByMonitor[mon] = {};
            if (!appsByMonitor[mon][app]) appsByMonitor[mon][app] = new Set();
            appsByMonitor[mon][app].add(ws);
          }
        }
      });
    }
    
    const parsedMonitors = Object.keys(appsByMonitor).map(mon => ({
      name: mon,
      apps: Object.keys(appsByMonitor[mon]).map(appName => ({
        name: appName,
        workspaces: Array.from(appsByMonitor[mon][appName]).sort((a, b) => parseInt(a) - parseInt(b))
      })).sort((a, b) => {
        const wsA = parseInt(a.workspaces[0]) || 0;
        const wsB = parseInt(b.workspaces[0]) || 0;
        return wsA - wsB;
      })
    }));

    ensureIcons(parsedMonitors, dispatch);
    dispatch({ type: "UPDATE_FAST_STATS", data: { workspace, monitors: parsedMonitors } });
  } catch (e) {
    dispatch({ type: "ERROR", error: e.toString() });
  }
};

const handleSlowOutput = (output, dispatch) => {
  if (window.statBarLastSlow === output) return;
  window.statBarLastSlow = output;
  try {
    const parts = output.split('---');
    
    const wifiRaw = parts[0] || "";
    const audioRaw = (parts[1] || "").trim().toLowerCase();
    const batteryRaw = parts[2] || "";
    const wifiPowerRaw = parts[3] || "";
    
    let wifiSpeed = "Off";
    if (wifiPowerRaw.includes("On")) {
      wifiSpeed = wifiRaw.includes("status: active") ? "Con" : "On";
    }
    
    let audioType = 'speaker';
    if (/headphones|external/.test(audioRaw)) {
      audioType = 'headphones';
    } else if (/airpods|bluetooth|bose|sony|beats|buds|ear|pod/.test(audioRaw)) {
      audioType = 'bluetooth';
    }

    const battMatch = batteryRaw.match(/(\d+)%/);
    const battery = battMatch ? battMatch[1] : "?";
    const isCharging = /AC Power|\bcharging\b/i.test(batteryRaw);

    // RAM & swap — only parse when charging (displayed only on charger)
    let ramUsed = null;
    let swapUsed = null;
    if (isCharging) {
      const vmStatRaw = parts[4] || "";
      const sysctlRaw = parts[5] || "";

      // vm_stat: page size line + "Pages active/inactive/speculative/wired" lines
      const pageSize = 16384;
      const getPages = label => {
        const m = vmStatRaw.match(new RegExp(label + ':\\s+(\\d+)'));
        return m ? parseInt(m[1]) : 0;
      };
      // Activity Monitor "Memory Used" formula: (App Memory + Wired + Compressed)
      // App Memory = Anonymous pages - Purgeable pages
      const usedPages = getPages('Anonymous pages') - getPages('Pages purgeable') + getPages('Pages wired down') + getPages('Pages occupied by compressor');
      const totalMem = parseInt((sysctlRaw.match(/hw\.memsize:\s+(\d+)/) || [])[1]) || 0;
      const usedBytes = usedPages * pageSize;
      ramUsed = totalMem > 0 ? (usedBytes / (1024 ** 3)).toFixed(1) : null;

      // swap
      const swapMatch = sysctlRaw.match(/used\s*=\s*([\d.]+)M/);
      if (swapMatch) {
        const swapMB = parseFloat(swapMatch[1]);
        swapUsed = swapMB >= 1024 ? (swapMB / 1024).toFixed(1) + "G" : Math.round(swapMB) + "M";
      }
    }

    dispatch({ type: "UPDATE_SLOW_STATS", data: { wifiSpeed, audioType, battery, isCharging, ramUsed, swapUsed } });

    // Auto-switch polling rates when charger is plugged/unplugged
    const expectedRate = isCharging ? 'charging' : 'battery';
    if (window.statBarCurrentRate !== expectedRate && window.statBarDispatch) {
      setupIntervals(window.statBarDispatch, isCharging);
    }
  } catch (e) {
    dispatch({ type: "ERROR", error: e.toString() });
  }
};

// ponytail: Adaptive polling — aggressive when plugged in, conservative on battery.
// Charging: 1s fast + 2s slow (extremely responsive for RAM/Swap, battery irrelevant)
// Battery:  3s fast + 30s slow (conservative)
const RATES = {
  charging: { fast: 1000, slow: 2000, tick: 30000 },
  battery:  { fast: 3000, slow: 30000, tick: 30000 },
};

const setupIntervals = (dispatch, charging) => {
  if (window.statBarFastClock) clearInterval(window.statBarFastClock);
  if (window.statBarSlowClock) clearInterval(window.statBarSlowClock);
  if (window.statBarTickClock) clearInterval(window.statBarTickClock);

  const rate = charging ? RATES.charging : RATES.battery;
  window.statBarCurrentRate = charging ? 'charging' : 'battery';

  window.statBarFastClock = setInterval(() => {
    run(FAST_CMD).then(output => handleFastOutput(output, dispatch));
  }, rate.fast);

  window.statBarSlowClock = setInterval(() => {
    run(SLOW_CMD).then(output => handleSlowOutput(output, dispatch));
  }, rate.slow);

  window.statBarTickClock = setInterval(() => {
    dispatch({ type: "TICK" });
  }, rate.tick);
};

export const command = dispatch => {
  // Store dispatch for rate switching from handleSlowOutput
  window.statBarDispatch = dispatch;

  setupIntervals(dispatch, false); // start conservative, will switch on first slow poll

  // Clear dedup caches so this trigger always processes fresh data + generates icons
  window.statBarLastFast = null;
  window.statBarLastSlow = null;

  // Immediate fetch on every trigger (including AeroSpace event callbacks)
  run(FAST_CMD).then(output => handleFastOutput(output, dispatch));
  run(SLOW_CMD).then(output => handleSlowOutput(output, dispatch));
};

export const className = {
  top: "0px",
  left: "0px",
  right: "0px",
  bottom: "0px",
  userSelect: "none",
  backgroundColor: "transparent",
  padding: "0px",
  boxSizing: "border-box",
  borderRadius: "0px",
  boxShadow: "none",
  overflow: "visible",
  pointerEvents: "none",
};

const containerClassName = css({
  color: "#ffffff",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fontSize: "14px",
  fontWeight: "500",
  height: "100%",
  width: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
});

const straightRightBorder = css({
  position: "absolute",
  right: "-1px",
  top: "24px",
  bottom: "24px",
  width: "0px",
  backgroundColor: "rgb(253, 253, 253)",
  zIndex: 10,
});

const topFlare = css({
  position: "absolute",
  top: 0,
  right: "-24px",
  width: "24px",
  height: "24px",
  background: "radial-gradient(circle at 100% 100%, transparent 22.5px, rgba(255, 255, 255, 0.02) 23px, rgba(255, 255, 255, 0) 24px, rgb(0, 0, 0) 24.5px)",
  zIndex: 10,
});

const bottomFlare = css({
  position: "absolute",
  bottom: 0,
  right: "-24px",
  width: "24px",
  height: "24px",
  background: "radial-gradient(circle at 100% 0%, transparent 22.5px, rgba(255, 255, 255, 0) 23px, rgba(255, 255, 255, 0) 24px, rgb(0, 0, 0) 24.5px)",
  zIndex: 10,
});


const leftPanelClass = css({
  position: "absolute",
  left: 0,
  top: 0,
  bottom: 0,
  width: options.width,
  backgroundColor: "rgb(0, 0, 0)",
  padding: "12px",
  boxSizing: "border-box",
  boxShadow: "8px 0 32px 0 rgba(0, 0, 0, 0.3)",
  overflow: "visible",
  pointerEvents: "auto",
});

const rightPanelTopFlare = css({
  position: "absolute",
  top: 0,
  right: 0,
  width: "24px",
  height: "24px",
  background: "radial-gradient(circle at 0% 100%, transparent 22.5px, rgb(0, 0, 0) 23px, rgb(0, 0, 0) 24px, rgb(0, 0, 0) 24.5px)",
  zIndex: 10,
  pointerEvents: "none",
});

const rightPanelBottomFlare = css({
  position: "absolute",
  bottom: 0,
  right: 0,
  width: "24px",
  height: "24px",
  background: "radial-gradient(circle at 0% 0%, transparent 22.5px, rgba(255, 255, 255, 0) 23px, rgba(255, 255, 255, 0) 24px, rgb(0, 0, 0) 24.5px)",
  zIndex: 10,
  pointerEvents: "none",
});



const cyan = css({ color: "#cccccc" });
const orange = css({ color: "#dddddd" });

const metricStyle = css({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "4px",
  backgroundColor: "transparent",
  fontSize: "11px",
  textAlign: "center",
  width: "100%",
  boxSizing: "border-box",
});

const metricsStyle = css({
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  height: "100%",
  width: "100%",
  gap: "10px",
});

const metricsStyleColumn = css({
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-start",
  alignItems: "stretch",
  width: "100%",
  gap: "10px",
});

let cachedState;
if (typeof window !== "undefined") {
  try {
    const raw = window.localStorage.getItem("sidebarState");
    if (raw) cachedState = JSON.parse(raw);
  } catch (e) {}
}

export const initialState = cachedState || {
  workspace: "-",
  monitors: [],
  wifiSpeed: "-",
  audioType: "speaker",
  battery: "?",
  isCharging: false,
  ramUsed: null,
  swapUsed: null,
  tick: 0
};

export const updateState = (event, previousState) => {
  if (event.error) {
    return { ...previousState, warning: `Error: ${event.error}` };
  }
  
  if (event.type === "TICK" || event.type === "ICON_LOADED") {
    return { ...previousState, tick: Date.now() };
  }

  if (event.type === "UPDATE_FAST_STATS") {
    // ponytail: no localStorage write here — workspace refreshes within 1s on reload anyway
    return {
      ...previousState,
      workspace: event.data.workspace,
      monitors: event.data.monitors,
      warning: false
    };
  }
  
  if (event.type === "UPDATE_SLOW_STATS") {
    const newState = {
      ...previousState,
      wifiSpeed: event.data.wifiSpeed,
      audioType: event.data.audioType,
      battery: event.data.battery,
      isCharging: event.data.isCharging,
      ramUsed: event.data.ramUsed,
      swapUsed: event.data.swapUsed,
      warning: false
    };
    if (typeof window !== "undefined") {
      try { window.localStorage.setItem("sidebarState", JSON.stringify(newState)); } catch (e) {}
    }
    return newState;
  }
  return previousState;
};

// ponytail: Extracted all static inline css() classes to bypass Emotion's object hashing per render loop
const workspaceContainerClass = css({
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "36px", height: "36px", borderRadius: "10px",
  backgroundColor: "rgba(255, 255, 255, 0.15)", color: "#ffffff",
  fontWeight: "800", fontSize: "20px",
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.2)"
});
const monitorsWrapperClass = css({
  flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-start",
  alignItems: "center", width: "100%", gap: "16px", overflow: "hidden", paddingTop: "10px"
});
const monitorSectionBase = css({
  display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", width: "100%"
});
const monitorTitleClass = css({
  fontSize: "10px", color: "rgba(255, 255, 255, 0.7)", fontWeight: "bold", textAlign: "center", lineHeight: "1", opacity: 0.8
});
const appContainerClass = css({
  display: "flex", flexDirection: "column", alignItems: "center", gap: "2px"
});
const appBadgesWrapperClass = css({
  display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "2px", maxWidth: "40px"
});
const badgeBase = css({
  fontSize: "9px", fontWeight: "bold", borderRadius: "4px", padding: "1px 4px", lineHeight: 1
});

const IconWifi = ({ className }) => <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"></path><path d="M1.42 9a16 16 0 0 1 21.16 0"></path><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line></svg>;
const IconWifiOff = ({ className }) => <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="2" y1="2" x2="22" y2="22"></line><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line></svg>;
const IconSpeaker = ({ className }) => <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>;
const IconHeadphones = ({ className }) => <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"></path><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path></svg>;
const IconBluetooth = ({ className }) => <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"></polyline></svg>;
const IconBattery = ({ className }) => <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="6" width="18" height="12" rx="2" ry="2"></rect><line x1="23" y1="13" x2="23" y2="11"></line></svg>;
const IconBatteryCharging = ({ className }) => <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 18H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.19M15 6h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-3.19"></path><line x1="23" y1="13" x2="23" y2="11"></line><polyline points="11 6 7 12 13 12 9 18"></polyline></svg>;
const IconApple = ({ className, style }) => <svg className={className} style={style} viewBox="0 0 384 512" fill="currentColor"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.1-44.6-35.9-2.8-74.3 22.7-93.1 22.7-18.9 0-48.6-21.9-77.6-21.9-38.6 0-74.1 22.9-94.6 57.6-41.5 70.3-10.6 174.5 29.8 233.1 19.8 28.7 43.6 60.9 74.8 59.8 29.8-1.1 41.5-19.1 77.2-19.1 35.5 0 46.2 19.1 77.5 18.8 32.4-.4 53.6-29.8 73-58.4 22.9-33.8 32.4-66.5 32.9-68.2-1.2-.5-65.7-25.2-65.8-94zM242.3 84.1c16.3-19.9 27.2-47.6 24.3-75.1-23.7 1-52.6 15.9-69.5 36.1-14.7 17.5-27.4 46-23.6 72.8 26.5 2.1 52.5-13.8 68.8-33.8z"/></svg>;

// ponytail: Extracted expensive Intl formatters out of the render loop (Saves ~5-10ms of pure JS thread blocking per render)
const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'long' });
const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

export const render = ({ warning, workspace, monitors, wifiSpeed, audioType, battery, isCharging, ramUsed, swapUsed }) => {
  if (warning) {
    return <div>{warning}</div>;
  }

  const now = new Date();
  const month = monthFmt.format(now).slice(0, 4).toUpperCase();
  const day = dayFmt.format(now);
  const dayNum = now.getDate();
  const time = timeFmt.format(now);

  let AudioIcon = IconSpeaker;
  let audioLabel = "Spkr";
  if (audioType === "headphones") {
    AudioIcon = IconHeadphones;
    audioLabel = "H-Ph";
  } else if (audioType === "bluetooth") {
    AudioIcon = IconBluetooth;
    audioLabel = "BT";
  }

  const BatteryIcon = isCharging ? IconBatteryCharging : IconBattery;
  const WifiIconComponent = wifiSpeed === "Off" ? IconWifiOff : IconWifi;

  return (
    <div style={{ width: "100%", height: "100%" }}>
      {/* Left Panel */}
      <div className={leftPanelClass}>
        <div className={containerClassName}>
          <div className={straightRightBorder} />
          <div className={topFlare} />
          <div className={bottomFlare} />
          <div className={metricsStyle}>
            <div className={metricsStyleColumn}>
              <div className={metricStyle} style={{ gap: "4px" }}>
                <IconApple className={cyan} style={{ marginBottom: "2px", width: "34px", height: "34px" }} />
                <span style={{ fontSize: "12px", fontWeight: "600", textTransform: "uppercase" }}>{month}</span>
                <span style={{ fontSize: "12px", fontWeight: "600", whiteSpace: "nowrap" }}>{day} {dayNum}</span>
                <span style={{ fontSize: "12px", fontWeight: "600" }}>{time}</span>
              </div>
              <div className={metricStyle}>
                <div key={workspace} className={workspaceContainerClass}>
                  {workspace}
                </div>
              </div>
            </div>
            <div className={monitorsWrapperClass}>
              {monitors && monitors.length > 0 ? monitors.map((monitor, mIdx) => (
                <div key={mIdx} className={monitorSectionBase} style={{ borderTop: mIdx > 0 ? "1px solid rgba(255, 255, 255, 0.2)" : "none", paddingTop: mIdx > 0 ? "10px" : "0" }}>
                  <div className={monitorTitleClass}>
                    {monitor.name.includes("Built-in") ? "MAC" : monitor.name.substring(0, 3).toUpperCase()}
                  </div>
                  {monitor.apps.map((appObj, i) => (
                    <div key={i} className={appContainerClass} title={appObj.name}>
                      <img 
                        src={window.statBarIconCache?.has(appObj.name) ? `SideBar.widget/icons/${appObj.name}.png` : "SideBar.widget/icons/fallback.png"} 
                        style={{ width: "32px", height: "32px", objectFit: "contain" }}
                      />
                      <div className={appBadgesWrapperClass}>
                        {appObj.workspaces.map(ws => (
                          <span key={ws} className={badgeBase} style={{
                            backgroundColor: ws === workspace ? "rgba(255, 255, 255, 0.25)" : "rgba(0,0,0,0.4)",
                            color: ws === workspace ? "#ffffff" : "#aaaaaa"
                          }}>
                            {ws}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )) : <div className={metricStyle}><span>-</span></div>}
            </div>
            <div className={metricsStyleColumn}>
              {isCharging && ramUsed && (
                <div className={metricStyle}>
                  <span style={{ fontSize: "10px", color: "rgba(255, 255, 255, 0.5)", fontWeight: "bold" }}>RAM</span>
                  <span style={{ fontSize: "11px" }}>{ramUsed}G</span>
                </div>
              )}
              {isCharging && swapUsed && (
                <div className={metricStyle}>
                  <span style={{ fontSize: "10px", color: "rgba(255, 255, 255, 0.5)", fontWeight: "bold" }}>SWP</span>
                  <span style={{ fontSize: "11px" }}>{swapUsed}</span>
                </div>
              )}
              <div className={metricStyle}>
                <BatteryIcon className={cyan} /> {battery}%
              </div>
              <div className={metricStyle}>
                <AudioIcon className={cyan} /> {audioLabel}
              </div>
              <div className={metricStyle}>
                <WifiIconComponent className={cyan} /> {wifiSpeed}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right Side Curves */}
      <div className={rightPanelTopFlare} />
      <div className={rightPanelBottomFlare} />
    </div>
  );
};
