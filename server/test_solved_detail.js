import 'dotenv/config';
import { solveDeedText } from './services/deedTextSolver.js';

const deedText = `A parcel of land being a parcel of land, situated in ______ County, ______, more particularly described as follows: BEGINNING at a point, said point being the Point of Beginning (POB), having coordinates of Northing 5000.00, Easting 5000.00; THENCE South 54°40'00" West, a distance of 458.10 feet; THENCE along a curve to the Left, having a radius of 424.73 feet, a central angle of 93°62'00.00", an arc length of 93.43 feet, a chord bearing of South 16°38'52" East, and a chord distance of 93.43 feet; THENCE South 22°57'45" East, a distance of 36.10 feet; THENCE along a curve to the Left, having a radius of 710.48 feet, a central angle of 87°32'100.00", an arc length of 87.28 feet, a chord bearing of South 63°30'55" West, and a chord distance of 87.28 feet; THENCE South 64°40'00" West, a distance of 51.39 feet; THENCE South 14°58'30" East, a distance of 636.00 feet; THENCE North 52°46'44.44" East, a distance of 602.68 feet; THENCE North 14°58'30" West, a distance of 723.00 feetto the Point of Beginning. Said parcel containing 9.0340 acres, more or less, and having a perimeter of 2687.98 feet. Bearings are based on the deed`;

async function main() {
  const model = process.env.ACTIVE_MODEL || 'deepseek-r1:14b';
  console.log(`Running solveDeedText...`);
  const result = await solveDeedText(deedText, model, {
    pobNorthing: 5000,
    pobEasting: 5000,
    units: 'Feet'
  });
  console.log('--- TEST RESULTS ---');
  console.log('Result status:', result.status);
  console.log('Traverse linear error:', result.traverse?.closure?.linearError);
  console.log('Traverse exists:', !!result.traverse);
}

main();
