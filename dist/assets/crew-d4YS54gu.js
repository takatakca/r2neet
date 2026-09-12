import"./modulepreload-polyfill-B5Qt9EMX.js";let p="";const o=t=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Toronto",hour:"numeric",minute:"2-digit"}).format(new Date(t)),a=t=>String(t??"").replace(/[&<>"]/g,s=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[s]);let i=[];async function d(t,s={}){const n=await fetch(t,{...s,credentials:"same-origin",headers:{"Content-Type":"application/json",...s.headers||{}}});if(!n.ok){const e=await n.json().catch(()=>({})),l=new Error(e.error?.message||n.statusText);throw l.status=n.status,l}return n.json()}const c=["COMPLETED"],r=["EN_ROUTE","ARRIVED","IN_PROGRESS"],v={CONFIRMED:"EN_ROUTE",ASSIGNED:"EN_ROUTE",EN_ROUTE:"ARRIVED",ARRIVED:"IN_PROGRESS",IN_PROGRESS:"COMPLETED"},b={EN_ROUTE:"On my way",ARRIVED:"I have arrived",IN_PROGRESS:"Start cleaning",COMPLETED:"Finish job"};async function u(){const t=document.getElementById("list");t.innerHTML='<div class="empty">Loading…</div>';try{const s=await d("/api/v1/staff/me");p=s.user.staffId||"",document.getElementById("hTitle").textContent=s.user.displayName?`${s.user.displayName.split(" ")[0]}'s jobs`:"My jobs",i=(await d("/api/v1/crew/jobs")).jobs,document.getElementById("hSub").textContent=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Toronto",weekday:"long",month:"long",day:"numeric"}).format(new Date)+` · ${i.length} job${i.length===1?"":"s"}`,g()}catch(s){t.innerHTML=s.status===401?`<div class="empty"><div class="big">Please sign in</div>
         Use your own R2NETTE account to see your jobs.<br><br>
         <a class="btn btn-go" href="/admin">Sign in</a></div>`:`<div class="empty"><div class="big">Couldn't load your jobs</div>${a(s.message)}</div>`}}function g(){const t=document.getElementById("list");if(!i.length){t.innerHTML='<div class="empty"><div class="big">Nothing scheduled today</div>Enjoy the day off.</div>';return}const s=i.find(e=>!c.includes(e.status));let n="";s&&(n+=`<div class="next">
      <div class="lbl">${r.includes(s.status)?"In progress":"Next job"}</div>
      <div class="time">${o(s.startAt)}</div>
      <div class="svc">${a(s.service)} · ${s.durationMinutes/60} h · ${s.crewSize} cleaner${s.crewSize===1?"":"s"}</div>
      <div class="addr">${a(s.address)}${s.unit?`<br>Unit ${a(s.unit)}`:""}</div>
      <div class="actions">
        <button class="btn btn-go" onclick="openJob('${s.id}')">Open job</button>
        <a class="btn btn-map" href="${m(s)}" target="_blank" rel="noopener">Directions</a>
      </div></div>`),n+='<div class="sect">Today</div>',n+=i.map(e=>`<button class="job ${c.includes(e.status)?"done":r.includes(e.status)?"active":""}" onclick="openJob('${e.id}')">
      <div class="t">${o(e.startAt)}</div>
      <div class="b"><b>${a(e.service)}</b>
        <span>${a(e.customerFirstName)} · ${a(e.city)}</span>
        <span style="margin-top:6px"><span class="pill ${c.includes(e.status)?"ok":r.includes(e.status)?"now":"mut"}">${e.status.replace("_"," ")}</span></span>
      </div></button>`).join(""),t.innerHTML=n}function m(t){return t.latitude&&t.longitude?`https://www.google.com/maps/dir/?api=1&destination=${t.latitude},${t.longitude}`:`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(t.address)}`}window.openJob=t=>{const s=i.find(e=>e.id===t);if(!s)return;const n=v[s.status];document.getElementById("detail").innerHTML=`
    <button class="back" onclick="showList()">← Today's jobs</button>
    <h2 style="font-size:23px;margin-bottom:4px">${a(s.service)}</h2>
    <div style="color:var(--muted);margin-bottom:16px">${o(s.startAt)} – ${o(s.endAt)} · ${s.durationMinutes/60} h</div>
    <div class="detail">
      <div class="row"><span class="k">Customer</span><span class="v">${a(s.customerFirstName)}</span></div>
      <div class="row"><span class="k">Address</span><span class="v">${a(s.address)}${s.unit?`<br>Unit ${a(s.unit)}`:""}</span></div>
      <div class="row"><span class="k">Crew</span><span class="v">${s.crewSize} cleaner${s.crewSize===1?"":"s"}</span></div>
      <div class="row"><span class="k">Status</span><span class="v">${s.status.replace("_"," ")}</span></div>
      <div class="row"><span class="k">Job</span><span class="v mono" style="font-size:13px">${s.bookingNumber}</span></div>
    </div>
    <a class="btn btn-ghost btn-full" href="${m(s)}" target="_blank" rel="noopener">Open directions</a>
    ${n?`<div class="steps"><button class="btn ${n==="COMPLETED"?"btn-done":"btn-go"} btn-full" onclick="advance('${s.id}','${n}')">${b[n]}</button></div>`:'<div class="note" style="background:rgba(14,138,99,.1);border-color:rgba(14,138,99,.3)">This job is complete. Nice work.</div>'}
    <div class="sect">Something wrong?</div>
    <div class="issues">
      ${["Cannot access property","Customer not home","Needs more time","Damage concern","Missing products","Other"].map(e=>`<button class="issue" onclick="reportIssue('${s.id}','${e}')">${e}</button>`).join("")}
    </div>`,document.getElementById("list").classList.remove("on"),document.getElementById("detail").classList.add("on"),window.scrollTo(0,0)};window.showList=()=>{document.getElementById("detail").classList.remove("on"),document.getElementById("list").classList.add("on")};window.advance=async(t,s)=>{try{await d(`/api/v1/crew/jobs/${t}/status`,{method:"POST",body:JSON.stringify({status:s})}),await u(),showList()}catch(n){alert(n.message)}};window.reportIssue=async(t,s)=>{const n=prompt(`Report: ${s}

Anything to add? (optional)`)??"";try{await d(`/api/v1/crew/jobs/${t}/issue`,{method:"POST",body:JSON.stringify({type:s,note:n})}),alert("Reported. Dispatch has been notified.")}catch(e){alert(e.message)}};u();
