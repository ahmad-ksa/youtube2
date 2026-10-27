// Runs from file:// when the app starts: jump to a bare youtube.com page where our user script takes over.
(function () {
  var hash = '#ytlg';
  try {
    var p = JSON.parse((window.PalmSystem && window.PalmSystem.launchParams) || '{}');
    var t = p.contentTarget || p.target || '';
    var m = String(t).match(/(?:v=|youtu\.be\/)([\w-]{11})/);
    if (m) hash += '&v=' + m[1];
    else {
      if (typeof t === 'string' && t.charAt(0) === '{') { try { t = JSON.parse(t); } catch (e2) { /* keep */ } }
      var q = typeof t === 'string' ? (t.match(/(?:^|[?&])q=([^&]+)/) || [])[1] : t && t.intentParam;
      if (q) hash += '&q=' + encodeURIComponent(decodeURIComponent(String(q).replace(/\+/g, ' ')));
    }
  } catch (e) { /* no params */ }
  window.location.href = 'https://www.youtube.com/robots.txt' + hash;
})();
