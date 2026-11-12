const access = document.querySelector('#access');
const workspace = document.querySelector('#workspace');
const upload = document.querySelector('#upload');
const result = document.querySelector('#result');
const token = location.hash.slice(1);
let code = '';
history.replaceState(null, '', location.pathname);

async function call(path, options = {}) {
  const response = await fetch('/api/portal/' + path, { ...options, cache: 'no-store', credentials: 'omit',
    headers: { Authorization: 'Bearer ' + token, 'X-Portal-Code': code, ...options.headers } });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error ?? 'This request could not be completed.');
  }
  return response;
}

function guarded(form, work) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    result.textContent = '';
    try { await work(); }
    catch (error) { result.textContent = error.message; }
    finally { button.disabled = false; }
  });
}

if (!/^[\da-f]{64}$/.test(token)) {
  access.hidden = true;
  result.textContent = 'Open the access link you received from your lawyer.';
}

guarded(access, async () => {
  code = access.elements.code.value.trim();
  const data = await (await call('info')).json();
  document.querySelector('#matter').textContent = data.matter;
  const files = document.querySelector('#files');
  files.replaceChildren();
  for (const item of data.files) {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Download ' + item.name;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const blob = await (await call('files/' + encodeURIComponent(item.id))).blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = item.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 30000);
      } catch (error) { result.textContent = error.message; }
      finally { button.disabled = false; }
    });
    row.append(button);
    files.append(row);
  }
  upload.hidden = !data.canUpload;
  access.hidden = true;
  workspace.hidden = false;
});

guarded(upload, async () => {
  const file = upload.elements.file.files[0];
  if (!file || !/\.pdf$/i.test(file.name) || !file.size || file.size > 25 * 1024 * 1024) throw new Error('Choose a PDF up to 25 MB.');
  const data = await (await call('upload', { method: 'POST', headers: {
    'Content-Type': 'application/pdf', 'X-PDF-Name': encodeURIComponent(file.name),
  }, body: file })).json();
  result.textContent = 'Submission ' + data.status + ' · receipt ' + data.receipt;
  upload.reset();
});
