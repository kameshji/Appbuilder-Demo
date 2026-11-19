// Forms. Nothing is posted to a third party. With forms.endpoint null (the default) a form composes an email
// in the visitor's own mail app; without JavaScript the browser's own mailto: form handling is used.
// Set forms.endpoint in site.config.json to POST to your own handler instead (see docs/launch/website.md).
import { config, esc, url } from "./layout.mjs";

const F = config.forms;

export function formOpen({ id, subject, lang = "en" }) {
  const endpoint = F.endpoint;
  const action = endpoint ? esc(endpoint) : `mailto:${esc(F.mailto)}?subject=${encodeURIComponent(subject)}`;
  const extra = endpoint ? `method="${esc(F.method || "POST")}" data-endpoint="1"` : `method="post" enctype="text/plain"`;
  return `<form class="form" id="${id}" action="${action}" ${extra} data-mailto="${esc(F.mailto)}" data-subject="${esc(subject)}" lang="${lang}">`;
}

export const field = ({ name, label, type = "text", required = false, hint = "", autocomplete = "", options, rows, value = "", min, max }) => {
  const id = `f-${name}`;
  const req = required ? " required" : "";
  const star = required ? ' <span class="req" aria-hidden="true">*</span><span class="visually-hidden">(required)</span>' : "";
  const hintId = hint ? `${id}-hint` : "";
  const desc = hint ? ` aria-describedby="${hintId}"` : "";
  const ac = autocomplete ? ` autocomplete="${autocomplete}"` : "";
  let control;
  if (type === "select") {
    control = `<select id="${id}" name="${name}" data-label="${esc(label)}"${req}${desc}>${options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}</select>`;
  } else if (type === "textarea") {
    control = `<textarea id="${id}" name="${name}" rows="${rows || 5}" data-label="${esc(label)}"${req}${desc}>${esc(value)}</textarea>`;
  } else {
    control = `<input id="${id}" name="${name}" type="${type}" data-label="${esc(label)}"${req}${desc}${ac}${min != null ? ` min="${min}"` : ""}${max != null ? ` max="${max}"` : ""}>`;
  }
  return `<div class="field"><label for="${id}">${esc(label)}${star}</label>${hint ? `<span class="hint" id="${hintId}">${esc(hint)}</span>` : ""}${control}</div>`;
};

export function formClose({ submit, lang = "en" }) {
  const hi = lang === "hi";
  const viaMail = !F.endpoint;
  return `<div class="privacy-box" id="privacy-note">
  <p><strong>${hi ? "आपकी जानकारी का क्या होगा" : "What happens to what you send"}</strong></p>
  <p>${viaMail
    ? (hi ? "यह फ़ॉर्म कुछ भी कहीं अपलोड नहीं करता। सबमिट करने पर आपके अपने ईमेल ऐप में एक संदेश तैयार होता है, जिसे आप भेजने से पहले देख और बदल सकते हैं।" : "This form does not upload anything. Submitting it opens a pre-filled email in your own mail app, which you can read and change before you send it.")
    : (hi ? "यह फ़ॉर्म आपकी जानकारी हमारे सर्वर पर भेजता है।" : "This form sends what you enter to our own server.")}
  ${hi ? "हम इसे सिर्फ़ आपके अनुरोध का जवाब देने के लिए इस्तेमाल करते हैं, किसी को बेचते या साझा नहीं करते, और आप कभी भी इसे मिटाने के लिए कह सकते हैं।" : "We use it only to reply to your request, never sell or share it, and delete it when you ask."}
  <a href="${url("/legal/privacy/")}">${hi ? "गोपनीयता सूचना (अंग्रेज़ी, ड्राफ़्ट)" : "Privacy notice (draft)"}</a>.</p>
</div>
<div class="field"><label class="choice"><input type="checkbox" name="consent" value="yes" required aria-describedby="privacy-note"> <span>${hi ? "मैं सहमत हूँ कि इस अनुरोध के बारे में मुझसे ईमेल या फ़ोन पर संपर्क किया जाए।" : "I agree to be contacted by email or phone about this request."} <span class="req" aria-hidden="true">*</span></span></label></div>
<div class="visually-hidden" aria-hidden="true"><label>Leave this empty <input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div>
<div class="btn-row"><button class="btn btn-primary" type="submit">${esc(submit)}</button>
<span class="muted small">${viaMail ? (hi ? "आपका ईमेल ऐप खुलेगा।" : `Opens your email app, addressed to ${esc(F.mailto)}.`) : ""}</span></div>
<div class="form-status" role="status" tabindex="-1" hidden>${hi ? "आपका ईमेल ऐप एक तैयार संदेश के साथ खुलना चाहिए। अगर नहीं खुला, तो सीधे लिखें: " : "Your email app should open with the message ready to send. If nothing happened, write to "}<a href="mailto:${esc(F.mailto)}">${esc(F.mailto)}</a>.</div>
</form>`;
}
