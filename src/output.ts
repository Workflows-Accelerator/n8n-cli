let isVerbose = false;

export function setVerbose(verbose: boolean) {
  isVerbose = verbose;
}

export function log(msg: string) {
  console.log(msg);
}

export function debug(msg: string) {
  if (isVerbose) {
    console.warn(`debug: ${msg}`);
  }
}

export function error(msg: string | Error) {
  if (msg instanceof Error) {
    console.error(`error: ${msg.message}`);
    if (isVerbose && msg.stack) {
      console.error(msg.stack);
    }
  } else {
    console.error(`error: ${msg}`);
  }
}

export function warn(msg: string) {
  console.warn(`warn: ${msg}`);
}

export function list(items: string[], indent = 2) {
  const spaces = ' '.repeat(indent);
  for (const item of items) {
    console.log(`${spaces}- ${item}`);
  }
}

export function table(headers: string[], rows: string[][]) {
  if (rows.length === 0) {
    console.log(headers.join('\t'));
    return;
  }

  // Calculate maximum width of each column
  const colWidths = headers.map((header, colIndex) => {
    let maxWidth = header.length;
    for (const row of rows) {
      const cell = row[colIndex] ?? '';
      if (cell.length > maxWidth) {
        maxWidth = cell.length;
      }
    }
    return maxWidth;
  });

  // Helper to format a row
  const formatRow = (row: string[]) => {
    return row.map((cell, colIndex) => {
      const width = colWidths[colIndex];
      return (cell ?? '').padEnd(width);
    }).join('  '); // two spaces separator
  };

  console.log(formatRow(headers));
  console.log(colWidths.map(width => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}
