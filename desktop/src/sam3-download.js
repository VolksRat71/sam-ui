// sam-ui (Apache-2.0). New file, not from SAM 2.
// The SAM 3 download window's page script (runs sandboxed; talks only through window.sam3).
'use strict';

const $ = id => document.getElementById(id);
$('model').onclick = () => window.sam3.openModelPage();
$('tokens').onclick = () => window.sam3.openTokenPage();

window.sam3.onProgress(({done, total, file}) => {
  $('bar').style.display = 'block';
  $('fill').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  $('status').className = '';
  $('status').textContent = `${file}: ${(done / 2 ** 30).toFixed(2)} of ${(total / 2 ** 30).toFixed(2)} GB`;
});

$('go').onclick = async () => {
  const input = $('token');
  const token = input.value.trim();
  if (!token) return;
  input.value = ''; // don't keep it in the page
  $('go').disabled = true;
  $('status').className = '';
  $('status').textContent = 'Checking access…';
  const r = await window.sam3.download(token);
  if (r.ok) {
    $('status').textContent = 'SAM 3 is ready. Restart the app to use it.';
    $('go').textContent = 'Restart now';
    $('go').disabled = false;
    $('go').onclick = () => window.sam3.restart();
  } else {
    $('status').className = 'error';
    $('status').textContent = r.error;
    $('go').disabled = false;
  }
};
