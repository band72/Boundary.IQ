import * as bp from '../services/Scripting/bearingParser.js';

try {
  const result1 = bp.parse('S5719\'54"W');
  console.log('Test 1 Passed! S5719\'54"W ->', bp.toDisplayString(result1.azimuthDeg));
  
  const result2 = bp.parse('S.5719’54”W.');
  console.log('Test 2 Passed! S.5719’54”W. ->', bp.toDisplayString(result2.azimuthDeg));

  const result3 = bp.parse('N1020\'E');
  console.log('Test 3 Passed! N1020\'E ->', bp.toDisplayString(result3.azimuthDeg));

  const result4 = bp.parse('E81°54\'58"N');
  console.log('Test 4 Passed! E81°54\'58"N ->', bp.toDisplayString(result4.azimuthDeg));

  const result5 = bp.parse('NORTH');
  console.log('Test 5 Passed! NORTH ->', bp.toDisplayString(result5.azimuthDeg));

  const result6 = bp.parse('E.');
  console.log('Test 6 Passed! E. ->', bp.toDisplayString(result6.azimuthDeg));

  const result7 = bp.parse('S89°04.43\'W');
  console.log('Test 7 Passed! S89°04.43\'W ->', bp.toDisplayString(result7.azimuthDeg), '(decDeg = ' + result7.azimuthDeg + ')');

  const result8 = bp.parse('S89°04.43W');
  console.log('Test 8 Passed! S89°04.43W ->', bp.toDisplayString(result8.azimuthDeg), '(decDeg = ' + result8.azimuthDeg + ')');

  const result9 = bp.parse('S89°21\'48"');
  console.log('Test 9 Passed! S89°21\'48" ->', bp.toDisplayString(result9.azimuthDeg));

  const result10 = bp.parse('89°21\'48"E');
  console.log('Test 10 Passed! 89°21\'48"E ->', bp.toDisplayString(result10.azimuthDeg));
} catch (e) {
  console.error('Test Failed:', e.message);
}
