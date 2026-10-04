// A "K" lit on a 5×5 dot grid, in the style of Kip's LED sign.
const LIT = new Set([0, 3, 5, 7, 10, 11, 15, 17, 20, 23])

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 25 25" aria-hidden="true">
      {Array.from({ length: 25 }, (_, index) => (
        <circle
          key={index}
          cx={(index % 5) * 5 + 2.5}
          cy={Math.floor(index / 5) * 5 + 2.5}
          r={1.7}
          className={LIT.has(index) ? 'lit' : 'unlit'}
        />
      ))}
    </svg>
  )
}
