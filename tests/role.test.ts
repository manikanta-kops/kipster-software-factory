import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderRole } from '../src/domain/role.ts'

for (const lightsOut of [false, true]) {
  test(`role variants preserve prose and spacing with lights-out ${lightsOut}`, () => {
    const text =
      'Before.\n\n<!-- default -->\n\nNormal.\nSecond line.\n\n<!-- /default -->\n\n<!-- lights-out -->\n\nOvernight.\n\n<!-- /lights-out -->\n\nAfter.\n'
    const rendered = renderRole(text, { lightsOut })
    assert.equal(
      rendered,
      `Before.\n\n${lightsOut ? 'Overnight.' : 'Normal.\nSecond line.'}\n\nAfter.\n`,
    )
    assert.doesNotMatch(rendered, /<!--/)
    assert.equal(
      renderRole('Unconditional.\n', { lightsOut }),
      'Unconditional.\n',
    )
    assert.equal(renderRole('', { lightsOut }), '')
    assert.equal(renderRole(text + text, { lightsOut }), rendered + rendered)
    assert.equal(
      renderRole(text.replaceAll('\n', '\r\n'), { lightsOut }),
      rendered.replaceAll('\n', '\r\n'),
    )
  })

  test(`malformed role variants throw with lights-out ${lightsOut}`, () => {
    for (const text of [
      '<!-- default -->\nNormal.',
      '<!-- /lights-out -->',
      '<!-- default -->\nNormal.\n<!-- /default -->',
      '<!-- lights-out -->\nOvernight.\n<!-- /lights-out -->',
      '<!-- default -->\nNormal.\n<!-- /lights-out -->',
      '<!-- default -->\n<!-- lights-out -->\nNested.\n<!-- /default -->\n<!-- lights-out -->\nOvernight.\n<!-- /lights-out -->',
      '<!-- default -->\nNormal.\n<!-- /default -->\nUnexpected prose.\n<!-- lights-out -->\nOvernight.\n<!-- /lights-out -->',
    ])
      assert.throws(() => renderRole(text, { lightsOut }), /role markers/)
  })
}
