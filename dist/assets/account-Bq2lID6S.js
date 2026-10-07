import"./modulepreload-polyfill-B5Qt9EMX.js";import{d as N,t as y,A as p,p as P,a as k,f as A,b as E,m as I,c as T,e as q}from"./api-DQxDmp8n.js";let l=N();const e=(t,a={})=>k(l,t,a),o=t=>document.getElementById(t),s=t=>String(t??"").replace(/[&<>"]/g,a=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[a]);let i=null,v=null,$=null,f=null;async function u(t,a={}){const n=await fetch(t,{...a,headers:{"Content-Type":"application/json",...a.headers??{}},credentials:"same-origin"}),d=await n.text(),r=d?JSON.parse(d):{};if(!n.ok){const c=r.error;throw new p(c?.code??"GENERIC",c?.message??"Request failed",n.status)}return r}let b=null;function h(t){const a=o("toast");a&&(a.textContent=t,a.classList.add("on"),b&&clearTimeout(b),b=setTimeout(()=>a.classList.remove("on"),4200))}const S=t=>{const a=o("sheetBody");a&&(a.innerHTML=t),o("sheet")?.classList.add("on")},C=()=>o("sheet")?.classList.remove("on");function M(t){return t.status==="CANCELLED"?`<span class="pill bad">${s(e("status.cancelled"))}</span>`:t.status==="COMPLETED"?`<span class="pill ok">${s(e("status.completed"))}</span>`:t.crewAssigned>=t.requiredStaffCount?`<span class="pill ok">${s(e("status.crewConfirmed"))}</span>`:`<span class="pill mut">${s(e("status.confirmed"))}</span>`}function x(t,a=!1){const n=new Intl.DateTimeFormat(l==="fr"?"fr-CA":"en-CA",{timeZone:"America/Toronto",weekday:"short",month:"short",day:"numeric"}).format(new Date(t.startAt)),d=t.paymentStatus==="PAID",r=a||t.canCancel||t.canReschedule?`<div class="acts">
        ${t.canReschedule?`<button class="btn btn-ghost" data-action="reschedule" data-id="${t.id}">${s(e("account.reschedule"))}</button>`:""}
        ${t.canCancel?`<button class="btn ${a?"btn-ghost":"btn-danger"}" data-action="cancel" data-id="${t.id}">${s(e("account.cancel"))}</button>`:""}
        ${t.withinCutoff?`<a class="btn btn-ghost" href="tel:+15148252825">${s(e("account.callToChange"))}</a>`:""}
      </div>`:"",c=t.withinCutoff?`<div class="note" style="margin-top:14px">${s(e("account.cutoffNote"))}</div>`:"";return`<div class="card${a?" next":""}">
    ${a?'<span class="bub" style="width:90px;height:90px;top:-24px;right:-18px"></span>':""}
    <div class="row1">
      <div class="when"><div class="d">${s(n)}</div>
        <div class="t">${s(T(t.startAt,l))}</div></div>
      <div class="info"><b>${s(l==="fr"?t.serviceNameFr:t.serviceName)}</b>
        <span>${s(t.addressSummary)}</span>
        <span class="mono" style="margin-top:6px">${s(t.bookingNumber)}</span>
        <div style="margin-top:9px;display:flex;gap:7px;flex-wrap:wrap">
          ${M(t)}
          <span class="pill ${d?"ok":"gold"}">${s(e(d?"confirm.paid":"confirm.payLater"))}</span>
          <span class="pill mut mono">${q(t.grandTotalCents,l)}</span>
        </div>
      </div>
    </div>
    ${c}${r}</div>`}function L(){if(!i)return;const t=o("greeting");t&&(t.textContent=i.customer.firstName?e("account.greeting",{name:i.customer.firstName}):e("account.title"));const a=o("subline");a&&(a.textContent=i.upcoming.length?e("account.nextCount",{n:i.upcoming.length}):e("account.noneScheduled"));const n=o("upcoming");n&&(n.innerHTML=i.upcoming.length?i.upcoming.map((c,g)=>x(c,g===0)).join(""):`<div class="empty"><div class="ic">🧼</div>
          <div class="t">${s(e("account.emptyTitle"))}</div>
          <div class="s">${s(e("account.emptyBody"))}</div>
          <a class="btn btn-primary" href="/login?returnTo=%2Faccount">
            Sign in
          </a>
        </div>`);const d=o("past");d&&(d.innerHTML=i.past.length?i.past.map(c=>x(c)).join(""):`<div class="empty"><div class="ic">📋</div>
          <div class="t">${s(e("account.noPast"))}</div></div>`),setTimeout(()=>void O(),0);const r=o("settings");r&&(r.innerHTML=`
      <div class="section"><h2>${s(e("account.yourDetails"))}</h2>
        <div class="card">
          <div style="display:grid;gap:12px">
            <div><label class="d" style="font-size:13px;font-weight:600">${s(e("details.name"))}</label>
              <input class="slot" style="width:100%;text-align:left;padding:13px 14px;font-weight:400"
                id="pfName" value="${s(i.customer.firstName??"")}"></div>
            <div><label class="d" style="font-size:13px;font-weight:600">${s(e("details.email"))}</label>
              <input class="slot" style="width:100%;text-align:left;padding:13px 14px;font-weight:400"
                id="pfEmail" type="email" value="${s(i.customer.email??"")}"></div>
            <div class="note">${s(e("details.verified"))}: <b>${s(i.customer.verifiedPhone?I(i.customer.verifiedPhone):"—")}</b></div>
          </div>
          <div class="err" id="pfErr" hidden></div>
          <div class="acts"><button class="btn btn-primary" data-action="save-profile">${s(e("account.save"))}</button></div>
        </div>
      </div>

      <div class="section"><h2>${s(e("account.places"))}</h2>
        ${i.addresses.length?i.addresses.map(c=>`
          <div class="card"><div class="addr">
            <div class="t"><b>${s(c.label??e("account.home"))}</b><span>${s(c.formattedAddress)}</span></div>
            ${c.isDefault?`<span class="pill ok">${s(e("account.default"))}</span>`:`<button class="btn-quiet" data-action="make-default" data-id="${c.id}">${s(e("account.makeDefault"))}</button>`}
            <button class="btn-quiet" data-action="delete-address" data-id="${c.id}">${s(e("account.remove"))}</button>
          </div></div>`).join(""):`<div class="note">${s(e("account.noPlaces"))}</div>`}
      </div>

      <div class="section"><h2>${s(e("account.plans"))}</h2>
        ${i.plans.length?i.plans.map(c=>`
          <div class="card"><div class="addr"><div class="t">
            <b>${s(c.serviceName)}</b>
            <span>${s(e("frequency."+c.frequency))} · ${s(c.addressSummary)}</span>
            <span class="mono" id="next-${c.id}">${s(e("common.loading"))}</span>
          </div><span class="pill ${c.status==="ACTIVE"?"ok":"mut"}">${s(e("status."+c.status.toLowerCase()))}</span></div>
          <div class="acts">
            ${c.canPause?`<button class="btn btn-ghost" data-action="plan-status" data-id="${c.id}" data-status="PAUSED">${s(e("account.pausePlan"))}</button>`:""}
            ${c.canResume?`<button class="btn btn-primary" data-action="plan-status" data-id="${c.id}" data-status="ACTIVE">${s(e("account.resumePlan"))}</button>`:""}
          </div></div>`).join(""):`<div class="note">${s(e("account.noPlans"))}</div>`}
      </div>

      <div class="section"><h2>${s(e("account.payment"))}</h2>
        ${i.paymentMethods.length?i.paymentMethods.map(c=>`
          <div class="card"><div class="addr"><div class="t">
            <b>${s((c.brand??"Card").toUpperCase())} •••• ${s(c.last4??"")}</b>
            <span>${s(e("account.savedCard"))}</span></div>
            ${c.isDefault?`<span class="pill ok">${s(e("account.default"))}</span>`:""}
          </div></div>`).join(""):`<div class="note">${s(e("account.noCards"))}</div>`}
      </div>`)}async function O(){for(const t of i?.plans??[]){const a=o(`next-${t.id}`);if(a)try{const n=await u(`/api/v1/account/plans/${t.id}/upcoming`);a.textContent=n.upcoming.length?`${e("account.nextVisits")}: ${n.upcoming.slice(0,3).map(d=>A(d,l)).join(" · ")}`:e("account.noUpcoming")}catch{a.textContent=""}}}async function m(){try{i=await u("/api/v1/account/overview"),L()}catch(t){const a=o("upcoming"),n=t instanceof p&&t.code==="UNAUTHORIZED";a&&(a.innerHTML=`<div class="empty"><div class="ic">${n?"🔐":"⚠"}</div>
        <div class="t">${s(e(n?"account.signInTitle":"error.GENERIC"))}</div>
        <div class="s">${s(n?e("account.signInBody"):"")}</div>
        <a class="btn btn-primary" href="/login?returnTo=%2Faccount">
          Sign in
        </a>
        </div>`)}}async function H(t){v=i?.upcoming.find(a=>a.id===t)??null,v&&(f=null,$=E(new Date(Date.now()+2*864e5)),R(),w())}function R(){const t=[];for(let n=1;n<=14;n++)t.push(E(new Date(Date.now()+n*864e5)));const a=(n,d)=>{const[r,c,g]=n.split("-").map(Number);return new Intl.DateTimeFormat(l==="fr"?"fr-CA":"en-CA",{timeZone:"America/Toronto",...d}).format(new Date(Date.UTC(r,c-1,g,16)))};S(`<h2>${s(e("account.pickNewTime"))}</h2>
    <p class="s">${s(e("account.currentlyAt",{when:A(v.startAt,l)+" · "+T(v.startAt,l)}))}</p>
    <div class="days">${t.map(n=>`<button class="day" data-action="resch-day" data-day="${n}" aria-pressed="${$===n}">
        <span class="w">${s(a(n,{weekday:"short"}))}</span>
        <span class="n">${s(a(n,{day:"numeric"}))}</span></button>`).join("")}</div>
    <div id="reschSlots"></div>
    <div class="err" id="reschErr" hidden></div>
    <div class="acts" style="margin-top:16px">
      <button class="btn btn-primary" id="reschConfirm" data-action="resch-confirm" disabled>${s(e("account.confirmChange"))}</button>
      <button class="btn-quiet" data-action="close-sheet">${s(e("common.back"))}</button>
    </div>`)}async function w(){const t=o("reschSlots");if(!(!t||!v||!$)){t.innerHTML=`<div class="slots">${'<div class="sk" style="height:48px;margin:0"></div>'.repeat(6)}</div>`;try{const a=await u(`/api/v1/availability?serviceOptionId=${encodeURIComponent(v.serviceOptionId)}&date=${$}`);t.innerHTML=a.slots.length?`<div class="slots">${a.slots.map(n=>`<button class="slot" data-action="resch-slot" data-slot="${n.startAt}"
          aria-pressed="${f===n.startAt}">${s(T(n.startAt,l))}</button>`).join("")}</div>`:`<div class="note">${s(e("slots.none"))}</div>`}catch{t.innerHTML=`<div class="note">${s(e("error.GENERIC"))}</div>`}}}function j(t){const a=i?.upcoming.find(n=>n.id===t);a&&S(`<h2>${s(e("account.cancelTitle"))}</h2>
    <p class="s">${s(e("account.cancelBody",{when:A(a.startAt,l)}))}</p>
    <div class="note">${s(e("account.cancelPolicy"))}</div>
    <div class="err" id="cancelErr" hidden></div>
    <div class="acts" style="margin-top:18px">
      <button class="btn btn-danger" id="cancelGo" data-action="cancel-confirm" data-id="${t}">${s(e("account.cancelConfirm"))}</button>
      <button class="btn-quiet" data-action="close-sheet">${s(e("account.keepIt"))}</button>
    </div>`)}const U={"set-locale":t=>{l=t.dataset.locale,P(l),D(),L()},tab:t=>{const a=t.dataset.pane;document.querySelectorAll(".tab").forEach(n=>n.classList.toggle("on",n.dataset.pane===a)),document.querySelectorAll(".pane").forEach(n=>n.classList.toggle("on",n.id===a))},"close-sheet":()=>C(),reschedule:t=>void H(t.dataset.id),"resch-day":t=>{$=t.dataset.day,f=null;const a=o("reschConfirm");a&&(a.disabled=!0),document.querySelectorAll(".day").forEach(n=>n.setAttribute("aria-pressed",String(n.dataset.day===$))),w()},"resch-slot":t=>{f=t.dataset.slot,document.querySelectorAll(".slot").forEach(n=>n.setAttribute("aria-pressed",String(n.dataset.slot===f)));const a=o("reschConfirm");a&&(a.disabled=!1)},"resch-confirm":async()=>{if(!v||!f)return;const t=o("reschConfirm");t.disabled=!0,t.innerHTML=`<span class="spin"></span> ${s(e("account.saving"))}`;try{await u(`/api/v1/account/bookings/${v.id}/reschedule`,{method:"POST",body:JSON.stringify({startAt:f})}),C(),h(e("account.moved")),await m()}catch(a){const n=o("reschErr");n&&(n.textContent=y(l,a instanceof p?a.code:void 0),n.hidden=!1),t.disabled=!1,t.textContent=e("account.confirmChange"),a instanceof p&&a.code==="SLOT_UNAVAILABLE"&&w()}},cancel:t=>j(t.dataset.id),"cancel-confirm":async t=>{const a=o("cancelGo");a.disabled=!0,a.innerHTML=`<span class="spin"></span> ${s(e("account.saving"))}`;try{await u(`/api/v1/account/bookings/${t.dataset.id}/cancel`,{method:"POST"}),C(),h(e("account.cancelled")),await m()}catch(n){const d=o("cancelErr");d&&(d.textContent=y(l,n instanceof p?n.code:void 0),d.hidden=!1),a.disabled=!1,a.textContent=e("account.cancelConfirm")}},"plan-status":async t=>{try{await u(`/api/v1/account/plans/${t.dataset.id}/status`,{method:"POST",body:JSON.stringify({status:t.dataset.status})}),h(t.dataset.status==="PAUSED"?e("account.planPaused"):e("account.planResumed")),await m()}catch(a){h(y(l,a instanceof p?a.code:void 0))}},"make-default":async t=>{await u(`/api/v1/account/addresses/${t.dataset.id}/default`,{method:"POST"}),await m()},"delete-address":async t=>{try{await u(`/api/v1/account/addresses/${t.dataset.id}`,{method:"DELETE"}),await m()}catch(a){h(y(l,a instanceof p?a.code:void 0))}},"save-profile":async()=>{const t=o("pfName")?.value??"",a=o("pfEmail")?.value??"";try{await u("/api/v1/account/profile",{method:"PATCH",body:JSON.stringify({firstName:t,email:a})}),h(e("account.saved")),await m()}catch(n){const d=o("pfErr");d&&(d.textContent=y(l,n instanceof p?n.code:void 0),d.hidden=!1)}}};function D(){document.documentElement.lang=l==="fr"?"fr-CA":"en-CA",document.querySelectorAll("[data-t]").forEach(t=>{const a=e(t.dataset.t);a!==t.dataset.t&&(t.textContent=a)}),document.querySelectorAll(".lang button").forEach(t=>t.setAttribute("aria-pressed",String(t.dataset.locale===l)))}function B(){document.addEventListener("click",t=>{const a=t.target.closest("[data-action]");if(!a)return;const n=U[a.dataset.action];n&&(t.preventDefault(),n(a))}),D(),m()}try{B()}catch(t){console.error("[r2nette account] boot failed",t);const a=document.getElementById("upcoming");a&&(a.innerHTML=`<div class="empty"><div class="ic">⚠</div>
      <div class="t">This page is temporarily unavailable.</div>
      <div class="s">Please try again, or call us and we'll help.</div>
      <a class="btn btn-primary" href="tel:+15148252825">Call (514) 825-2825</a></div>`)}
