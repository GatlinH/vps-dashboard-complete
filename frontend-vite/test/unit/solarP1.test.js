import { describe, expect, it } from 'vitest';
import { mapRadial, physicalToDisplay } from '../../src/components/solar/CoordinateMapper.js';
import { createEphemerisProvider } from '../../src/components/solar/EphemerisProvider.js';
describe('P1 math',()=>{it('maps nodes continuously',()=>{expect(mapRadial(.39)).toBe(9);expect(mapRadial(1)).toBe(19);expect(mapRadial(30.1)).toBe(62)});it('axes',()=>{const a=physicalToDisplay({x:1,y:2,z:3}); expect(a.x).toBeCloseTo(mapRadial(Math.sqrt(14))/Math.sqrt(14)); expect(a.z).toBeCloseTo(-2*mapRadial(Math.sqrt(14))/Math.sqrt(14)); expect(a.y).toBe(0)});it('rejects range',()=>{const p=createEphemerisProvider({states:[[0,0,0,0,1,1,1],[1,1,1,1,1,1,1]]});expect(p.sample(2).ok).toBe(false)});});
