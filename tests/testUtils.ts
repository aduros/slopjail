import { expect } from 'vitest'
import type { ExecutionOptions, Sandbox } from '../src'

let counter = 0

/** Gets an expression using both .run() and .evaluate(). */
export async function expression(
  sandbox: Sandbox,
  expr: string,
  opts?: ExecutionOptions,
): Promise<unknown> {
  const tmpVar = `globalThis.__testExpression${counter++}`
  const [valueFromRun, valueFromEvaluate] = await Promise.all([
    sandbox
      .run(`${tmpVar} = ${expr}`, opts)
      .then(() => sandbox.evaluate(tmpVar)),
    sandbox.evaluate(expr, opts),
  ])
  expect(valueFromRun).toStrictEqual(valueFromEvaluate)
  return valueFromRun
}
