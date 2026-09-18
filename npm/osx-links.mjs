const r = await fetch('https://api.github.com/repos/tpoechtrager/osxcross/git/matching-refs/tags/', { headers: { accept: 'application/json' } });
console.log(JSON.stringify(await r.json()));
