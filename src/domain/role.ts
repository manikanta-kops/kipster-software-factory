/** Paired default/lights-out blocks have their own lines; surrounding prose is preserved. */
export function renderRole(
  text: string,
  { lightsOut }: { lightsOut: boolean },
): string {
  const marker = /<!--\s*\/?(?:default|lights-out)\s*-->/
  const rendered = text.replace(
    /<!-- default -->\r?\n([\s\S]*?)\r?\n<!-- \/default -->\s*<!-- lights-out -->\r?\n([\s\S]*?)\r?\n<!-- \/lights-out -->/g,
    (_block, normal: string, overnight: string) => {
      if (marker.test(normal) || marker.test(overnight))
        throw new Error('Nested or unbalanced role markers')
      // Blank lines around markers belong to the template, not the prompt.
      return (lightsOut ? overnight : normal).replace(
        /^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g,
        '',
      )
    },
  )
  if (marker.test(rendered))
    throw new Error('Unpaired or unbalanced role markers')
  return rendered
}
