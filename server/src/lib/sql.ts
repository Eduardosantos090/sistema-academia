/** Montador de cláusulas WHERE sempre parametrizadas. */
export class Where {
  readonly params: unknown[] = [];
  private readonly parts: string[] = [];

  /** Adiciona condição; cada "?" vira o placeholder do valor informado. */
  add(sql: string, value: unknown): this {
    const ph = this.param(value);
    this.parts.push(sql.replace(/\?/g, () => ph));
    return this;
  }

  raw(sql: string): this {
    this.parts.push(sql);
    return this;
  }

  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  get clause(): string {
    return this.parts.length ? `where ${this.parts.join(' and ')}` : '';
  }
}
