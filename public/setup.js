(function () {
  var origin = location.origin;
  var app = origin + '/index.html';
  // MOVACALカルテ画面の「ID:01579」から orca_id を、URL先頭の /20221/ から clinic_id を取得して引き渡す
  var bm =
    "javascript:(function(){try{" +
    "var APP=" + JSON.stringify(app) + ";" +
    "function FT(){var s=(document.body?(document.body.innerText||document.body.textContent||''):'');" +
    "try{var f=document.querySelectorAll('iframe,frame');for(var i=0;i<f.length;i++){try{var d=f[i].contentDocument;if(d&&d.body)s+='\\n'+(d.body.innerText||d.body.textContent||'');}catch(_){}}}catch(_){}return s;}" +
    "var ti=document.title||'';var t=FT();" +
    "var id='';var re=/[\\uFF08(]\\s*([0-9A-Za-z_-]{1,32})\\s*[)\\uFF09]/g,x,lm=null;while((x=re.exec(ti)))lm=x;if(lm)id=lm[1];" +
    "if(!id){var m=t.match(/(?:^|[^0-9A-Za-z])ID\\s*[:\\uFF1A]\\s*([0-9A-Za-z][0-9A-Za-z_-]{0,31})/);if(m)id=m[1];}" +
    "var fn=(t.match(/やまと[^\\s\\u3000<]{0,24}/)||[])[0]||'';" +
    "var cm=location.pathname.match(/^\\/(\\d+)(?:\\/|$)/);" +
    "var c=cm?cm[1]:'';" +
    "if(!id){alert('患者IDを自動取得できませんでした。\\nSafariのタブ名が「患者名（ID）」になっているか確認してください。');}" +
    "var q=[];if(id)q.push('orcaId='+encodeURIComponent(id));if(c)q.push('clinicId='+encodeURIComponent(c));if(fn)q.push('clinicName='+encodeURIComponent(fn));" +
    "window.open(APP+(q.length?('?'+q.join('&')):''),'movacal_voice_karte');" +
    "}catch(e){window.open(" + JSON.stringify(app) + ",'movacal_voice_karte');}})();";

  var codeEl = document.getElementById('code');
  if (codeEl) codeEl.value = bm;

  var btn = document.getElementById('copyCode');
  if (btn) {
    btn.addEventListener('click', async function () {
      var ta = document.getElementById('code');
      try {
        if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(ta.value);
        else { ta.focus(); ta.select(); document.execCommand('copy'); }
        btn.textContent = 'コピーしました';
        setTimeout(function () { btn.textContent = 'コードをコピー'; }, 1500);
      } catch (e) {
        alert('コピーに失敗しました。コードを長押しして手動でコピーしてください。');
      }
    });
  }
})();
