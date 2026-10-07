import"./modulepreload-polyfill-B5Qt9EMX.js";let h=null;const w={dashboard:"dashboard.view",dispatch:"dispatch.view",roster:"dispatch.view",callbacks:"callbacks.view",billing:"dashboard.view",reviews:"reviews.view",integrations:"integrations.view",cutover:"cutover.view",security:null,operations:"integrations.view"},k=e=>"$"+(e/100).toFixed(2),E=e=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Toronto",hour:"numeric",minute:"2-digit"}).format(new Date(e));async function c(e,t={}){const a=await fetch(e,{...t,credentials:"same-origin",headers:{"Content-Type":"application/json",...t.headers||{}}}),s=e.includes("/staff/login");if(a.status===401&&!s)throw A(),new Error("Please sign in.");if(!a.ok){const i=await a.json().catch(()=>({})),d=new Error(i.error?.message||a.statusText);throw d.code=i.error?.code,d}return a.json()}function A(e){document.getElementById("gate").style.display="grid";const t=document.getElementById("shell");t.hidden=!0,t.style.display="none"}function _(){const e=new Set(h?.permissions??[]);let t=null;for(const s of document.querySelectorAll("nav.side a[data-nav]")){const i=w[s.dataset.nav],d=i===null||!i||e.has(i);s.hidden=!d,d&&!t&&(t=s.dataset.nav)}const a={ops:["dashboard","dispatch","roster","callbacks","billing"],content:["reviews"],setup:["integrations","cutover","security","operations"]};for(const[s,i]of Object.entries(a)){const d=document.querySelector(`.grp[data-group="${s}"]`);d&&(d.hidden=!i.some(n=>w[n]===null||e.has(w[n])))}return document.getElementById("whoami").innerHTML=`<b>${o(h.user.displayName)}</b>${o(h.user.email)}
     <span class="role">${o(h.user.role)}</span>
     <button type="button" onclick="signOut()">Sign out</button>`,t||(document.querySelector("main").innerHTML=`<div class="panel"><div class="empty"><div class="big">This account is for cleaners</div>
       Your jobs live in the crew app.<br><br>
       <a class="btn" href="/crew">Open my jobs</a></div></div>`,null)}window.signOut=async()=>{await fetch("/api/v1/staff/logout",{method:"POST",credentials:"same-origin"}),location.reload()};let C=null;document.getElementById("loginForm").addEventListener("submit",async e=>{e.preventDefault();const t=document.getElementById("loginBtn"),a=document.getElementById("loginErr");a.hidden=!0,t.disabled=!0,t.textContent="Signing in…";try{const s=await c("/api/v1/staff/login",{method:"POST",body:JSON.stringify({email:document.getElementById("email").value,password:document.getElementById("password").value})});if(s.twoFactorRequired){C=s.challengeToken,document.getElementById("loginForm").hidden=!0;const i=document.getElementById("totpForm");i.hidden=!1,document.getElementById("totpWho").textContent=`Hi ${s.displayName}. Enter the 6-digit code from your authenticator app.`,document.getElementById("totpCode").focus();return}location.reload()}catch(s){a.textContent=s.message,a.hidden=!1,t.disabled=!1,t.textContent="Sign in"}});document.getElementById("totpForm").addEventListener("submit",async e=>{e.preventDefault();const t=document.getElementById("totpBtn"),a=document.getElementById("totpErr");a.hidden=!0,t.disabled=!0,t.textContent="Verifying…";try{await c("/api/v1/staff/login/totp",{method:"POST",body:JSON.stringify({challengeToken:C,code:document.getElementById("totpCode").value})}),location.reload()}catch(s){a.textContent=s.message,a.hidden=!1,t.disabled=!1,t.textContent="Verify",document.getElementById("totpCode").value="",document.getElementById("totpCode").focus()}});const o=e=>String(e??"").replace(/[&<>"]/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[t]);function m(e,t){e.innerHTML=`<div class="panel"><div class="empty"><div class="big">Couldn't load this</div>${o(t.message)}</div></div>`}async function O(){const e=document.getElementById("dashboard");e.innerHTML='<div class="panel"><div class="empty">Loading…</div></div>';try{const t=await c("/api/v1/admin/dashboard"),a=t.needsAttention,s=a.callbacksWaiting+(a.dunningCases||0)+a.unassignedJobs+a.reviewsPendingModeration;e.innerHTML=`
      <div class="hdr"><div><h1>Today</h1><div class="sub">${t.date} · America/Toronto</div></div></div>
      <div class="cards">
        <div class="card"><div class="k">Bookings today</div><div class="v">${t.today.bookings}</div></div>
        <div class="card"><div class="k">Cleaners active</div><div class="v">${t.today.cleanersActive}</div></div>
        <div class="card"><div class="k">Booked value</div><div class="v">${k(t.today.revenueCents)}</div><div class="d">Taxes included</div></div>
        <div class="card ${s>0?"alert":"good"}"><div class="k">Needs attention</div><div class="v">${s}</div>
          <div class="d">${a.unassignedJobs} unassigned · ${a.callbacksWaiting} callbacks · ${a.dunningCases||0} billing</div></div>
      </div>
      <div class="panel">
        <div class="panel-h"><h2>Next jobs</h2><a class="btn ghost" href="#dispatch">Open dispatch</a></div>
        ${t.upcoming.length?`<table><thead><tr><th>When</th><th>Customer</th><th>Service</th><th>Address</th><th>Crew</th><th>Status</th></tr></thead><tbody>
          ${t.upcoming.map(i=>`<tr>
            <td class="mono">${E(i.startAt)}</td>
            <td>${o(i.customerName)}<div style="font-size:12px;color:var(--muted)" class="mono">${i.bookingNumber}</div></td>
            <td>${o(i.service)}</td><td>${o(i.address)}</td>
            <td><span class="pill ${i.crewSize>=i.requiredStaffCount?"ok":"bad"}">${i.crewSize}/${i.requiredStaffCount}</span></td>
            <td><span class="pill mut">${i.status}</span></td></tr>`).join("")}
        </tbody></table>`:'<div class="empty"><div class="big">No upcoming jobs</div>New bookings appear here as they come in.</div>'}
      </div>`}catch(t){m(e,t)}}async function x(){const e=document.getElementById("dispatch");e.innerHTML='<div class="panel"><div class="empty">Loading…</div></div>';try{const t=await c("/api/v1/admin/dispatch"),a=8,s=17,i=(s-a)*60,d=l=>{const v=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Toronto",hour:"2-digit",minute:"2-digit",hour12:!1}).formatToParts(new Date(l)),r=+v.find(p=>p.type==="hour").value,u=+v.find(p=>p.type==="minute").value;return(r*60+u-a*60)/i*100},n=t.bookings.filter(l=>l.assignedStaffIds.length<l.requiredStaffCount);e.innerHTML=`
      <div class="hdr"><div><h1>Dispatch</h1><div class="sub">${t.date} · ${t.bookings.length} jobs · ${t.staff.length} cleaners</div></div></div>
      ${n.length?`<div class="panel">
        <div class="panel-h"><h2>Needs a crew (${n.length})</h2></div>
        <div style="padding:14px" class="unassigned-list">
        ${n.map(l=>`<div class="job-row">
          <div class="when">${E(l.startAt)}</div>
          <div class="who"><b>${o(l.service)}</b><span>${o(l.customerName)} · ${o(l.city)} · ${l.assignedStaffIds.length}/${l.requiredStaffCount} assigned</span></div>
          <select id="sel-${l.id}">${t.staff.filter(v=>!v.onTimeOff&&!l.assignedStaffIds.includes(v.id)).map(v=>`<option value="${v.id}">${o(v.displayName)}</option>`).join("")}</select>
          <button class="btn" onclick="assign('${l.id}')">Assign</button>
        </div>`).join("")}
        </div></div>`:""}
      <div class="panel">
        <div class="panel-h"><h2>Day board</h2><span class="sub">8:00 – 17:00</span></div>
        <div style="padding:16px" class="board">
        ${t.staff.map(l=>{const v=t.bookings.filter(r=>r.assignedStaffIds.includes(l.id));return`<div class="lane">
            <div class="lane-name">${o(l.displayName)}<div class="meta">${l.onTimeOff?"Time off":`${v.length} job${v.length===1?"":"s"}`}</div></div>
            <div class="lane-track"><div class="hours">${Array.from({length:9},(r,u)=>`<div>${a+u}:00</div>`).join("")}</div>
            ${v.map(r=>{const u=d(r.startAt),p=r.durationMinutes/i*100;return`<div class="job" style="left:${u}%;width:${p}%" title="${o(r.customerName)} — ${o(r.address)}">
                <div class="t">${E(r.startAt)}</div><div class="s">${o(r.service)}</div></div>`}).join("")}
            </div></div>`}).join("")}
        </div>
        ${t.staff.length===0?'<div class="empty"><div class="big">No active cleaners</div>Add staff before dispatching.</div>':""}
      </div>`}catch(t){m(e,t)}}window.assign=async e=>{const t=document.getElementById("sel-"+e).value;try{await c(`/api/v1/admin/bookings/${e}/assign`,{method:"POST",body:JSON.stringify({staffId:t})}),x()}catch(a){alert(a.message)}};const B=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],I=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],$=e=>`${String(Math.floor(e/60)).padStart(2,"0")}:${String(e%60).padStart(2,"0")}`,b=()=>(h?.permissions||[]).includes("staff.manage"),D=()=>(h?.permissions||[]).includes("dispatch.assign"),S=e=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Toronto",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(e)),W=e=>S(new Date(new Date(e).getTime()-6e4).toISOString());let y=null,f=null;function q(){if(!y)return"";const e=y;return y=null,`<div class="banner ${e.kind}"><b>${o(e.title)}</b><div style="margin-top:6px">${e.body}</div></div>`}function U(e,t){if(!e.skills.length)return'<span class="pill mut">All services</span>';const a={cat_basic:"Basic",cat_deep:"Deep",cat_other:"Specialty"},s={};for(const d of e.skills){const n=t.find(l=>l.id===d);n&&(s[n.categoryId]=(s[n.categoryId]||0)+1)}return Object.entries(s).map(([d,n])=>`<span class="pill aqua">${a[d]||d} ${n}</span>`).join(" ")||'<span class="pill mut">Custom</span>'}function L(e,t,a){const s=new Set(a||[]);return(t||[]).map(i=>{const d=e.filter(n=>n.categoryId===i.id);return d.length?`<div class="skills-group">
      <h3>${o(i.name)}
        <button type="button" class="btn ghost tiny" onclick="toggleSkillGroup('${o(i.id)}',true)">All</button>
        <button type="button" class="btn ghost tiny" onclick="toggleSkillGroup('${o(i.id)}',false)">None</button>
      </h3>
      <div class="check-grid">${d.map(n=>`<label><input type="checkbox" class="skill-box" data-cat="${o(i.id)}" value="${o(n.id)}" ${s.has(n.id)?"checked":""}> ${o(n.name)}</label>`).join("")}</div>
    </div>`:""}).join("")}function R(){return[...document.querySelectorAll(".skill-box:checked")].map(e=>e.value)}window.toggleSkillGroup=(e,t)=>{for(const a of document.querySelectorAll(`.skill-box[data-cat="${e}"]`))a.checked=t};function M(e){return`<ul style="margin:8px 0 0;padding-left:18px" class="mono">${e.map(t=>`<li>${o(t.bookingNumber)}${t.startAt?" — "+new Date(t.startAt).toLocaleString("en-CA",{timeZone:"America/Toronto"}):""}</li>`).join("")}</ul>`}async function g(){const e=document.getElementById("roster");e.innerHTML='<div class="panel"><div class="empty">Loading…</div></div>';try{const t=await c("/api/v1/admin/roster");f=t;const a=t.staff.filter(n=>n.active),s=t.coverage.filter(n=>!n.canStaffTwoPersonJobs),i=b(),d=D();e.innerHTML=`
      <div class="hdr"><div><h1>Staff &amp; Cleaners</h1>
        <div class="sub">Who works, and when. Availability is what the booking page can offer.</div></div>
        ${i?'<button class="btn" onclick="addCleaner()">Add cleaner</button>':""}</div>
      ${q()}

      <div class="cards">
        <div class="card"><div class="k">Active</div><div class="v">${a.length}</div></div>
        <div class="card ${s.length?"alert":"good"}"><div class="k">Days without a pair</div>
          <div class="v">${s.length}</div><div class="d">Two-cleaner services need two people free</div></div>
        <div class="card"><div class="k">Hours offered</div>
          <div class="v">${a.reduce((n,l)=>n+l.weeklyHours,0)}</div><div class="d">Per week</div></div>
      </div>

      <div class="panel"><div class="panel-h"><h2>Weekly coverage</h2></div>
      <table><thead><tr><th>Day</th><th>Cleaners</th><th>From</th><th>To</th><th>Two-cleaner jobs</th></tr></thead><tbody>
        ${t.coverage.map(n=>`<tr>
          <td><b>${n.name}</b></td>
          <td><span class="pill ${n.cleaners===0?"bad":n.cleaners===1?"warn":"ok"}">${n.cleaners}</span></td>
          <td class="mono">${n.earliest??"—"}</td><td class="mono">${n.latest??"—"}</td>
          <td>${n.canStaffTwoPersonJobs?'<span class="pill ok">Yes</span>':'<span class="pill bad">No</span>'}</td>
        </tr>`).join("")}
      </tbody></table></div>

      <div class="panel"><div class="panel-h"><h2>Team</h2></div>
      ${t.staff.length?`<table><thead><tr><th>Name</th><th>Skills</th><th>Week</th><th>Hours</th><th>Upcoming</th><th>Status</th><th></th></tr></thead><tbody>
        ${t.staff.map(n=>`<tr>
          <td><b>${o(n.displayName)}</b>${n.hasLogin?' <span class="pill mut">has login</span>':""}</td>
          <td>${U(n,t.services)}</td>
          <td style="font-size:12.5px" class="mono">${n.availability.length?[...new Set(n.availability.map(l=>l.weekday))].sort().map(l=>B[l]).join(" "):'<span style="color:var(--danger)">none — cannot be booked</span>'}</td>
          <td class="mono">${n.weeklyHours}h</td>
          <td class="mono">${n.upcomingJobs}</td>
          <td>${n.onTimeOffUntil?'<span class="pill warn">Time off</span>':n.active?'<span class="pill ok">Active</span>':'<span class="pill mut">Inactive</span>'}</td>
          <td style="white-space:nowrap">
            ${i?`<button class="btn ghost" onclick="editWeek('${n.id}')">Hours</button>`:""}
            ${i?`<button class="btn ghost" onclick="editSkills('${n.id}')">Skills</button>`:""}
            ${d?`<button class="btn ghost" onclick="editTimeOff('${n.id}')">Time off</button>`:""}
            ${i?n.active?`<button class="btn ghost" onclick="setActive('${n.id}',false)">Deactivate</button>`:`<button class="btn" onclick="setActive('${n.id}',true)">Reactivate</button>`:""}
          </td></tr>`).join("")}
      </tbody></table>`:'<div class="empty"><div class="big">No cleaners yet</div>Nothing can be booked until at least one cleaner has availability.</div>'}
      </div>
      <div id="rosterEdit"></div>`}catch(t){m(e,t)}}function T(){const e=document.getElementById("rosterEdit");e&&(e.innerHTML="")}window.addCleaner=()=>{if(!b())return;const e=f||{services:[],categories:[]},t=document.getElementById("rosterEdit");t.innerHTML=`<div class="panel"><div class="panel-h"><h2>Hire a cleaner</h2></div>
    <div class="form-pad">
      <label class="gl" for="newName">Name</label>
      <input class="gi" id="newName" placeholder="First and last name" autocomplete="off">
      <label style="display:flex;gap:8px;align-items:center;margin:16px 0 18px;cursor:pointer">
        <input type="checkbox" id="useDefaultWeek" checked>
        Monday–Friday 08:00–17:00 (uncheck to create them unbookable for now)
      </label>
      <p class="hint">Leave skills empty to allow every service. Most hires should have Basic, Deep, and at least one specialty.</p>
      ${L(e.services,e.categories,[])}
      <div style="margin-top:8px">
        <button class="btn" onclick="saveNewCleaner()">Hire</button>
        <button class="btn ghost" onclick="closeRosterEdit()">Cancel</button>
      </div>
    </div></div>`,t.scrollIntoView({behavior:"smooth"}),document.getElementById("newName").focus()};window.saveNewCleaner=async()=>{const e=document.getElementById("newName").value.trim();if(!e){alert("A cleaner needs a name.");return}try{await c("/api/v1/admin/roster",{method:"POST",body:JSON.stringify({displayName:e,useDefaultWeek:document.getElementById("useDefaultWeek").checked,skills:R()})}),y={kind:"ok",title:"Hired",body:o(e)+" is on the roster."},g()}catch(t){alert(t.message)}};window.editWeek=async e=>{var d;if(!b())return;const a=(f||await c("/api/v1/admin/roster")).staff.find(n=>n.id===e),s={};for(const n of a.availability)(s[d=n.weekday]||(s[d]=[])).push(n);const i=document.getElementById("rosterEdit");i.innerHTML=`<div class="panel"><div class="panel-h"><h2>${o(a.displayName)} — weekly hours</h2></div>
    <div class="form-pad"><p class="hint">A second window on the same day is a split shift. Overlapping windows are rejected, not merged.</p></div>
    <table><thead><tr><th>Day</th><th>Works</th><th>From</th><th>To</th><th>Split from</th><th>Split to</th></tr></thead><tbody>
    ${B.map((n,l)=>{const v=(s[l]||[]).slice().sort((p,F)=>p.startMinute-F.startMinute),r=v[0],u=v[1];return`<tr><td><b>${n}</b></td>
        <td><input type="checkbox" id="on-${l}" ${r?"checked":""}></td>
        <td><input class="gi sm" id="from-${l}" value="${r?$(r.startMinute):"08:00"}"></td>
        <td><input class="gi sm" id="to-${l}" value="${r?$(r.endMinute):"17:00"}"></td>
        <td><input class="gi sm" id="from2-${l}" value="${u?$(u.startMinute):""}" placeholder="—"></td>
        <td><input class="gi sm" id="to2-${l}" value="${u?$(u.endMinute):""}" placeholder="—"></td>
      </tr>`}).join("")}
    </tbody></table>
    <div class="form-pad"><button class="btn" onclick="saveWeek('${e}')">Save week</button>
    <button class="btn ghost" onclick="closeRosterEdit()">Cancel</button></div></div>`,i.scrollIntoView({behavior:"smooth"})};window.saveWeek=async e=>{const t=s=>{const i=/^(\d{1,2}):(\d{2})$/.exec((s||"").trim());return i?+i[1]*60+ +i[2]:null},a=[];for(let s=0;s<7;s++){if(!document.getElementById("on-"+s).checked)continue;const i=t(document.getElementById("from-"+s).value),d=t(document.getElementById("to-"+s).value);if(i===null||d===null){alert(`${I[s]}: use times like 08:00.`);return}a.push({weekday:s,startMinute:i,endMinute:d});const n=t(document.getElementById("from2-"+s).value),l=t(document.getElementById("to2-"+s).value);if(n!==null||l!==null){if(n===null||l===null){alert(`${I[s]}: fill both split-shift times, or leave both blank.`);return}a.push({weekday:s,startMinute:n,endMinute:l})}}try{const s=await c(`/api/v1/admin/roster/${e}/availability`,{method:"PUT",body:JSON.stringify({availability:a})});s.conflicts?.length&&(y={kind:"warn",title:`Saved, but ${s.conflicts.length} already-booked job${s.conflicts.length===1?"":"s"} now fall outside this week`,body:M(s.conflicts)+'<div style="margin-top:8px">Reassign them in Dispatch. They were not cancelled.</div>'}),T(),g()}catch(s){alert(s.message)}};window.editSkills=e=>{if(!b())return;const t=f,a=t.staff.find(i=>i.id===e),s=document.getElementById("rosterEdit");s.innerHTML=`<div class="panel"><div class="panel-h"><h2>${o(a.displayName)} — skills</h2></div>
    <div class="form-pad">
      <p class="hint">Empty means they can do every service. The booking engine reads this list.</p>
      ${L(t.services,t.categories,a.skills)}
      <button class="btn" onclick="saveSkills('${e}')">Save skills</button>
      <button class="btn ghost" onclick="closeRosterEdit()">Cancel</button>
    </div></div>`,s.scrollIntoView({behavior:"smooth"})};window.saveSkills=async e=>{try{await c(`/api/v1/admin/roster/${e}/skills`,{method:"PUT",body:JSON.stringify({skills:R()})}),T(),g()}catch(t){alert(t.message)}};window.editTimeOff=e=>{if(!D())return;const a=f.staff.find(d=>d.id===e),s=a.upcomingTimeOff||[],i=document.getElementById("rosterEdit");i.innerHTML=`<div class="panel"><div class="panel-h"><h2>${o(a.displayName)} — time off</h2></div>
    <div class="form-pad">
      <p class="hint">Dates are inclusive, America/Toronto. If this covers a booking, the booking numbers are named so they can be reassigned.</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
        <div><label class="gl" for="offFrom">From</label>
          <input class="gi" id="offFrom" type="date"></div>
        <div><label class="gl" for="offThrough">Through</label>
          <input class="gi" id="offThrough" type="date"></div>
        <div style="flex:1;min-width:160px"><label class="gl" for="offReason">Reason</label>
          <input class="gi" id="offReason" placeholder="Vacation, sick, …"></div>
      </div>
      <button class="btn" onclick="saveTimeOff('${e}')">Add time off</button>
      <button class="btn ghost" onclick="closeRosterEdit()">Cancel</button>
    </div>
    ${s.length?`<div class="panel-h"><h2>Upcoming</h2></div>
      ${s.map(d=>`<div class="job-row">
        <div class="when">${S(d.startAt)}</div>
        <div class="who"><b>${S(d.startAt)} → ${W(d.endAt)}</b>
          <span>${o(d.reason||"Time off")}</span></div>
        <button class="btn ghost" onclick="removeTimeOff('${d.id}')">Remove</button>
      </div>`).join("")}`:'<div class="empty">No upcoming time off.</div>'}
    </div>`,i.scrollIntoView({behavior:"smooth"})};window.saveTimeOff=async e=>{const t=document.getElementById("offFrom").value,a=document.getElementById("offThrough").value;if(!t||!a){alert("Pick a start and end date.");return}try{const s=await c(`/api/v1/admin/roster/${e}/time-off`,{method:"POST",body:JSON.stringify({from:t,through:a,reason:document.getElementById("offReason").value||"Time off"})});s.affectedBookings?.length&&(y={kind:"warn",title:`Recorded. ${s.affectedBookings.length} booked job${s.affectedBookings.length===1?"":"s"} fall in this period`,body:M(s.affectedBookings)+'<div style="margin-top:8px">Reassign them in Dispatch. They were not cancelled.</div>'}),T(),g()}catch(s){alert(s.message)}};window.removeTimeOff=async e=>{try{await c(`/api/v1/admin/roster/time-off/${e}`,{method:"DELETE"}),g()}catch(t){alert(t.message)}};window.setActive=async(e,t)=>{if(b())try{await c(`/api/v1/admin/roster/${e}/active`,{method:"POST",body:JSON.stringify({active:t})}),g()}catch(a){alert(a.message)}};async function P(){const e=document.getElementById("callbacks");e.innerHTML='<div class="panel"><div class="empty">Loading…</div></div>';try{const t=await c("/api/v1/admin/callbacks"),a=t.callbacks.filter(i=>["REQUESTED","QUEUED","STAFF_RINGING"].includes(i.status)),s=a.filter(i=>i.overdue);e.innerHTML=`
      <div class="hdr"><div><h1>Callback center</h1><div class="sub">Operational target: about ${t.targetMinutes} minutes — not a guarantee</div></div></div>
      <div class="cards">
        <div class="card"><div class="k">Waiting</div><div class="v">${a.length}</div></div>
        <div class="card ${s.length?"alert":"good"}"><div class="k">Past target</div><div class="v">${s.length}</div></div>
        <div class="card"><div class="k">Total today</div><div class="v">${t.callbacks.length}</div></div>
      </div>
      <div class="panel"><div class="panel-h"><h2>Requests</h2></div>
      ${t.callbacks.length?`<table><thead><tr><th>Phone</th><th>Reason</th><th>Waiting</th><th>Status</th><th>Attempts</th><th></th></tr></thead><tbody>
        ${t.callbacks.map(i=>`<tr>
          <td class="mono">${o(i.phoneE164)}</td>
          <td>${o(i.reason||"—")}<div style="font-size:12px;color:var(--muted)">${o(i.source)}</div></td>
          <td><span class="pill ${i.overdue?"bad":"mut"}">${i.ageMinutes} min</span></td>
          <td><span class="pill ${i.status==="CONNECTED"||i.status==="COMPLETED"?"ok":i.status==="FAILED"||i.status==="NO_ANSWER"?"bad":"aqua"}">${i.status}</span></td>
          <td class="mono">${i.attemptCount}</td>
          <td style="white-space:nowrap">
            <button class="btn" onclick="cbAction('${i.id}','dial')">Call</button>
            <button class="btn ghost" onclick="cbAction('${i.id}','complete')">Done</button>
          </td></tr>`).join("")}
      </tbody></table>`:'<div class="empty"><div class="big">No callback requests</div>Requests from the booking flow and concierge land here.</div>'}
      </div>`}catch(t){m(e,t)}}window.cbAction=async(e,t)=>{try{const a=await c(`/api/v1/admin/callbacks/${e}/${t}`,{method:"POST"});a.dialed===!1&&alert(a.reason==="VOICE_NOT_CONFIGURED"?"Twilio Voice is not configured — the request stays queued for a manual call.":`Not dialled: ${a.reason}`),P()}catch(a){alert(a.message)}};async function N(){const e=document.getElementById("billing");e.innerHTML='<div class="panel"><div class="empty">Loading…</div></div>';try{const t=await c("/api/v1/admin/billing"),a=t.summary;e.innerHTML=`
      <div class="hdr"><div><h1>Billing</h1>
        <div class="sub">Failed payments that need a person. The cleaning is never cancelled for a failed card.</div></div></div>
      <div class="cards">
        <div class="card ${a.open?"alert":"good"}"><div class="k">Needs contact</div><div class="v">${a.open}</div></div>
        <div class="card"><div class="k">Contacted</div><div class="v">${a.contacted}</div></div>
        <div class="card"><div class="k">Outstanding</div><div class="v">${k(a.totalOwedCents)}</div></div>
      </div>
      <div class="panel"><div class="panel-h"><h2>Customers to chase</h2></div>
      ${t.cases.length?`<table><thead><tr><th>Customer</th><th>Reason</th><th>Owed</th><th>Upcoming</th><th>Open</th><th></th></tr></thead><tbody>
        ${t.cases.map(s=>`<tr>
          <td><b>${o(s.customerName)}</b><div style="font-size:12px;color:var(--muted)" class="mono">${o(s.phone||"—")}</div></td>
          <td>${o(s.reason)}<div style="font-size:12px;color:var(--muted)">${s.failedCount} failed</div></td>
          <td class="mono">${k(s.totalOwedCents)}</td>
          <td><span class="pill ${s.upcomingBookings>0?"warn":"mut"}">${s.upcomingBookings}</span></td>
          <td><span class="pill ${s.daysOpen>3?"bad":"mut"}">${s.daysOpen}d</span></td>
          <td style="white-space:nowrap">
            ${s.status==="OPEN"?`<button class="btn" onclick="caseAction('${s.id}','contacted')">Mark contacted</button>`:""}
            <button class="btn ghost" onclick="caseAction('${s.id}','resolved')">Resolved</button>
          </td></tr>`).join("")}
      </tbody></table>`:'<div class="empty"><div class="big">Nothing to chase</div>Every payment is up to date.</div>'}
      </div>
      <div class="panel"><div class="panel-h"><h2>Recent charge failures</h2></div>
      ${t.recentFailures.length?`<table><thead><tr><th>Amount</th><th>Status</th><th>Reason</th><th>Attempt</th><th>Next retry</th><th></th></tr></thead><tbody>
        ${t.recentFailures.map(s=>`<tr>
          <td class="mono">${k(s.amountCents)}</td>
          <td><span class="pill ${s.status==="SOFT_FAILED"?"warn":"bad"}">${s.status.replace("_"," ")}</span></td>
          <td>${o(s.failureCode||"—")}</td>
          <td class="mono">${s.attemptNumber}</td>
          <td>${s.nextRetryAt?new Date(s.nextRetryAt).toLocaleString("en-CA"):"—"}</td>
          <td><button class="btn ghost" onclick="retryAttempt('${s.id}')">Retry now</button></td>
        </tr>`).join("")}
      </tbody></table>`:'<div class="empty">No recent failures.</div>'}
      </div>`}catch(t){m(e,t)}}window.caseAction=async(e,t)=>{try{await c(`/api/v1/admin/billing/cases/${e}/${t}`,{method:"POST",body:JSON.stringify({})}),N()}catch(a){alert(a.message)}};window.retryAttempt=async e=>{try{await c(`/api/v1/admin/billing/attempts/${e}/retry`,{method:"POST"}),alert("Queued. The billing worker will pick it up on its next run."),N()}catch(t){alert(t.message)}};async function j(){const e=document.getElementById("reviews");e.innerHTML='<div class="panel"><div class="empty">Loading…</div></div>';try{const t=await c("/api/v1/admin/reviews"),a=t.summary;e.innerHTML=`
      <div class="hdr"><div><h1>Reviews</h1><div class="sub">Aggregates are computed from published reviews only</div></div></div>
      <div class="cards">
        <div class="card"><div class="k">Average</div><div class="v">${a.averageRating??"—"}</div><div class="d">${a.averageRating===null?"No published reviews yet":"From "+a.reviewCount+" published"}</div></div>
        <div class="card"><div class="k">Published</div><div class="v">${a.reviewCount}</div></div>
        <div class="card"><div class="k">Pending</div><div class="v">${t.reviews.filter(s=>s.status==="PENDING").length}</div></div>
      </div>
      <div class="panel"><div class="panel-h"><h2>All reviews</h2><span class="sub">Source cannot be changed — it is earned at creation</span></div>
      ${t.reviews.length?`<table><thead><tr><th>Source</th><th>Reviewer</th><th>Rating</th><th>Review</th><th>Status</th><th></th></tr></thead><tbody>
        ${t.reviews.map(s=>`<tr>
          <td><span class="src ${s.source}"><span class="dot">${s.source[0]}</span>${s.source==="GOOGLE"?"Google":s.source==="R2NETTE_VERIFIED"?"Verified":s.source==="SETMORE_LEGACY"?"Setmore":"Manual"}</span></td>
          <td>${o(s.customerDisplayName)}</td>
          <td><span class="stars">${"★".repeat(s.rating)}</span></td>
          <td style="max-width:340px">${o((s.reviewText||"").slice(0,110))}${(s.reviewText||"").length>110?"…":""}</td>
          <td><span class="pill ${s.status==="PUBLISHED"?"ok":s.status==="PENDING"?"warn":"mut"}">${s.status}</span></td>
          <td style="white-space:nowrap">
            ${s.status!=="PUBLISHED"?`<button class="btn" onclick="revAction('${s.id}','publish')">Publish</button>`:`<button class="btn ghost" onclick="revAction('${s.id}','hide')">Hide</button>`}
            <button class="btn ghost" onclick="revAction('${s.id}','feature')">${s.featured?"Unfeature":"Feature"}</button>
          </td></tr>`).join("")}
      </tbody></table>`:`<div class="empty"><div class="big">No reviews yet</div>Sync Google or import your Setmore history to populate this.<br><br>
        <button class="btn" onclick="importDemo()">Run Setmore import (dry run)</button></div>`}
      </div>`}catch(t){m(e,t)}}window.revAction=async(e,t)=>{try{await c(`/api/v1/admin/reviews/${e}/${t}`,{method:"POST"}),j()}catch(a){alert(a.message)}};window.importDemo=async()=>{const t=await c("/api/v1/admin/reviews/import",{method:"POST",body:JSON.stringify({rows:[{externalId:"demo1",name:"Example Reviewer",rating:5,text:"Dry run only — nothing is written."}],dryRun:!0})});alert(`Dry run: ${t.report.found} found, ${t.report.valid} valid, ${t.report.invalid} invalid, ${t.report.duplicates} duplicates. Nothing written.`)};async function G(){const e=document.getElementById("integrations");try{const t=await c("/api/v1/admin/integrations");e.innerHTML=`
      <div class="hdr"><div><h1>Integrations</h1><div class="sub">Status is read from the environment — never set by hand</div></div></div>
      <div class="cards">
      ${t.integrations.map(a=>`<div class="card ${a.status==="CONNECTED"?"good":""}">
        <div class="k">${o(a.label)}</div>
        <div style="margin-top:10px"><span class="pill ${a.status==="CONNECTED"?"ok":"warn"}">${a.status.replace("_"," ")}</span></div>
        <div class="d">${a.status==="CONNECTED"?"Ready":"Missing: "+a.missingEnv.join(", ")}</div>
        <div class="d" style="margin-top:8px;color:var(--muted)">${o(a.blocks)}</div>
      </div>`).join("")}
      </div>`}catch(t){m(e,t)}}async function J(){const e=document.getElementById("cutover");try{const t=await c("/api/v1/admin/cutover"),a=t.items.filter(s=>s.status==="READY").length;e.innerHTML=`
      <div class="hdr"><div><h1>Setmore replacement status</h1><div class="sub">${a} of ${t.items.length} ready · everything below is computed from real data</div></div></div>
      <div class="panel"><table><thead><tr><th>Area</th><th>Status</th><th>Detail</th></tr></thead><tbody>
      ${t.items.map(s=>`<tr><td><b>${o(s.label)}</b></td>
        <td><span class="pill ${s.status==="READY"?"ok":s.status==="BLOCKED"?"bad":"warn"}">${s.status.replace("_"," ")}</span></td>
        <td style="color:var(--muted)">${o(s.detail)}</td></tr>`).join("")}
      </tbody></table></div>`}catch(t){m(e,t)}}async function V(){const e=document.getElementById("security"),t=h.user;e.innerHTML=`
    <div class="hdr"><div><h1>Security</h1>
      <div class="sub">Your account. Changes here affect only you.</div></div></div>
    <div class="tfa-card">
      <h2 style="font-size:17px;margin-bottom:6px">Two-step verification</h2>
      <p style="color:var(--muted);font-size:14px;margin:0 0 14px">
        ${t.twoFactorEnabled?`On. Sign-in asks for a code from your authenticator app. ${t.recoveryCodesRemaining} recovery code${t.recoveryCodesRemaining===1?"":"s"} left.`:t.twoFactorRecommended?"Off. Strongly recommended for owner accounts — a stolen password alone would be enough without it.":"Off. Adds a code from your phone to every sign-in."}
      </p>
      <div id="tfaBody"></div>
      ${t.twoFactorEnabled?`<button class="btn ghost" onclick="tfaDisable()">Turn off</button>
           <button class="btn ghost" onclick="tfaNewCodes()">New recovery codes</button>`:'<button class="btn" onclick="tfaBegin()">Turn on two-step verification</button>'}
    </div>`}window.tfaBegin=async()=>{try{const e=await c("/api/v1/staff/totp/begin",{method:"POST"});document.getElementById("tfaBody").innerHTML=`
      <p style="font-size:14px">Add this to your authenticator app, then enter the code it shows.</p>
      <div class="tfa-uri">${o(e.secret)}</div>
      <p style="font-size:12.5px;color:var(--muted)">Or open: <span class="tfa-uri" style="display:inline">${o(e.otpauthUri)}</span></p>
      <input class="gi mono" id="enrolCode" inputmode="numeric" maxlength="6" placeholder="000000" style="max-width:220px">
      <div class="gerr" id="enrolErr" hidden></div>
      <div style="margin-top:12px"><button class="btn" onclick="tfaConfirm()">Confirm</button></div>`}catch(e){alert(e.message)}};window.tfaConfirm=async()=>{const e=document.getElementById("enrolErr");e.hidden=!0;try{const t=await c("/api/v1/staff/totp/confirm",{method:"POST",body:JSON.stringify({code:document.getElementById("enrolCode").value})});document.getElementById("tfaBody").innerHTML=`
      <div class="pill ok" style="margin-bottom:12px">Two-step verification is on</div>
      <p style="font-size:14px"><b>Save these recovery codes now.</b> Each works once, and this is
      the only time they are shown. Without them, losing your phone means losing this account.</p>
      <div class="tfa-codes">${t.recoveryCodes.map(a=>`<div>${o(a)}</div>`).join("")}</div>
      <button class="btn" onclick="location.reload()">I have saved them</button>`}catch(t){e.textContent=t.message,e.hidden=!1}};window.tfaDisable=async()=>{const e=prompt("Confirm your password to turn off two-step verification:");if(e)try{await c("/api/v1/staff/totp/disable",{method:"POST",body:JSON.stringify({password:e})}),location.reload()}catch(t){alert(t.message)}};window.tfaNewCodes=async()=>{const e=prompt("Confirm your password to generate new recovery codes:");if(e)try{const t=await c("/api/v1/staff/totp/recovery-codes",{method:"POST",body:JSON.stringify({password:e})});document.getElementById("tfaBody").innerHTML=`<p style="font-size:14px"><b>New recovery codes. Your old ones no longer work.</b></p>
       <div class="tfa-codes">${t.recoveryCodes.map(a=>`<div>${o(a)}</div>`).join("")}</div>`}catch(t){alert(t.message)}};const z={HEALTHY:{cls:"ok",label:"Running"},NEVER_SUCCEEDED:{cls:"warn",label:"Never run here"},OVERDUE:{cls:"bad",label:"Stopped"},FAILING:{cls:"bad",label:"Failing"},NOT_CONFIGURED:{cls:"mut",label:"Not configured"},DISABLED:{cls:"mut",label:"Disabled"}};async function Y(){const e=document.getElementById("operations");e.innerHTML='<div class="panel"><div class="empty">Loading…</div></div>';try{const t=await c("/api/v1/admin/operations"),a=t.workers.filter(i=>i.status==="NEVER_SUCCEEDED"),s=t.workers.filter(i=>i.status==="OVERDUE"||i.status==="FAILING");e.innerHTML=`
      <div class="hdr"><div><h1>Automation</h1>
        <div class="sub">What runs without anyone remembering to run it.</div></div></div>
      <div class="cards">
        <div class="card ${s.length?"alert":"good"}"><div class="k">Stopped or failing</div>
          <div class="v">${s.length}</div><div class="d">Worked before, not now</div></div>
        <div class="card ${a.length?"alert":"good"}"><div class="k">Never run here</div>
          <div class="v">${a.length}</div><div class="d">Not yet proven in this environment</div></div>
        <div class="card ${t.alerts.length?"alert":"good"}"><div class="k">Open alerts</div>
          <div class="v">${t.alerts.length}</div></div>
      </div>

      ${t.offHostBackupConfigured?"":`<div class="panel"><div style="padding:16px;background:rgba(255,198,39,.12)">
        <b>Backups are staying on this machine.</b> Set the <span class="mono">BACKUP_S3_*</span>
        variables so a lost server does not take the backups with it.</div></div>`}

      <div class="panel"><div class="panel-h"><h2>Scheduled work</h2></div>
      <table><thead><tr><th>Job</th><th>Status</th><th>Last success</th><th>What it means</th></tr></thead><tbody>
        ${t.workers.map(i=>{const d=z[i.status]||{cls:"mut",label:i.status};return`<tr>
            <td><b>${o(i.label)}</b>${i.critical?' <span class="pill mut">required</span>':""}</td>
            <td><span class="pill ${d.cls}">${d.label}</span></td>
            <td class="mono" style="font-size:12.5px">${i.lastSuccessAt?new Date(i.lastSuccessAt).toLocaleString("en-CA"):"—"}</td>
            <td style="color:var(--muted);font-size:13.5px">${o(i.summary)}</td></tr>`}).join("")}
      </tbody></table></div>

      <div class="panel"><div class="panel-h"><h2>Open alerts</h2></div>
      ${t.alerts.length?`<table><thead><tr><th>Problem</th><th>Severity</th><th>Since</th><th>Seen</th><th>Sent</th></tr></thead><tbody>
        ${t.alerts.map(i=>`<tr>
          <td><b>${o(i.title)}</b><div style="font-size:12.5px;color:var(--muted)">${o(i.message)}</div></td>
          <td><span class="pill ${i.severity==="CRITICAL"?"bad":"warn"}">${i.severity}</span></td>
          <td class="mono" style="font-size:12.5px">${new Date(i.openedAt).toLocaleString("en-CA")}</td>
          <td class="mono">${i.observations}×</td>
          <td><span class="pill ${i.deliveryStatus==="DELIVERED"?"ok":"mut"}">${i.deliveryStatus.replace("_"," ")}</span></td>
        </tr>`).join("")}
      </tbody></table>`:'<div class="empty"><div class="big">Nothing wrong</div>Every required job has run recently.</div>'}
      </div>`}catch(t){m(e,t)}}const Z={dashboard:O,dispatch:x,roster:g,callbacks:P,billing:N,reviews:j,integrations:G,cutover:J,security:V,operations:Y};function H(){const e=(location.hash||"#dashboard").slice(1);for(const t of document.querySelectorAll(".page"))t.classList.toggle("on",t.id===e);for(const t of document.querySelectorAll("nav.side a"))t.classList.toggle("on",t.dataset.nav===e);(Z[e]||O)()}window.addEventListener("hashchange",H);(async function(){try{h=await c("/api/v1/staff/me")}catch{A();return}document.getElementById("gate").style.display="none";const t=document.getElementById("shell");t.hidden=!1,t.style.display="flex";const a=_();if(!a)return;const s=w[location.hash.slice(1)];(!location.hash||s!==null&&!h.permissions.includes(s??""))&&(location.hash="#"+a),H()})();
