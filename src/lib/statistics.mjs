export function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

export function pearson(left, right) {
  if (left.length !== right.length || left.length < 2) return 0;
  const leftMean = mean(left);
  const rightMean = mean(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const leftScale = Math.sqrt(left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0));
  const rightScale = Math.sqrt(right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
  return leftScale && rightScale ? numerator / (leftScale * rightScale) : 0;
}

export function standardizeMatrix(rows) {
  const columns = rows[0]?.length ?? 0;
  const means = Array.from({ length: columns }, (_, index) => mean(rows.map((row) => row[index])));
  const scales = means.map((columnMean, index) => {
    const variance = mean(rows.map((row) => (row[index] - columnMean) ** 2));
    return Math.sqrt(variance) || 1;
  });
  return { means, scales, rows: rows.map((row) => row.map((value, index) => (value - means[index]) / scales[index])) };
}

function solve(matrix, vector) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < augmented.length; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < augmented.length; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column] || 1e-12;
    augmented[column] = augmented[column].map((value) => value / divisor);
    for (let row = 0; row < augmented.length; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      augmented[row] = augmented[row].map((value, index) => value - factor * augmented[column][index]);
    }
  }
  return augmented.map((row) => row.at(-1));
}

export function ridgeFit(featureRows, targets, alpha = 1) {
  const standardized = standardizeMatrix(featureRows);
  const x = standardized.rows.map((row) => [1, ...row]);
  const width = x[0].length;
  const xtx = Array.from({ length: width }, (_, i) => Array.from({ length: width }, (_, j) =>
    x.reduce((sum, row) => sum + row[i] * row[j], 0) + (i === j && i > 0 ? alpha : 0)
  ));
  const xty = Array.from({ length: width }, (_, i) => x.reduce((sum, row, index) => sum + row[i] * targets[index], 0));
  return { coefficients: solve(xtx, xty), means: standardized.means, scales: standardized.scales };
}
