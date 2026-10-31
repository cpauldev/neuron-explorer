import { expect, it } from "vitest";
import { Vector3 } from "three";
import { flightPosition } from "../../../explorer/static/camera-flight.js";

it("restores the original overview direction after an arbitrary orbit and pan", () => {
  const target = new Vector3(20, 3, 0),
    rotated = new Vector3(-8, 2, -4);
  const homeDirection = new Vector3(0.62, 0.4, 1).normalize();
  const result = flightPosition(target, rotated, 60, 1, homeDirection);
  expect(result.distanceTo(target)).toBeCloseTo(60);
  expect(
    result.clone().sub(target).normalize().distanceTo(homeDirection),
  ).toBeLessThan(1e-10);
  expect(rotated.toArray()).toEqual([-8, 2, -4]);
  expect(target.toArray()).toEqual([20, 3, 0]);
});

it("keeps the current viewing angle for ordinary neuron focus moves", () => {
  const offset = new Vector3(-8, 2, -4),
    target = new Vector3(3, 1, 0);
  const result = flightPosition(target, offset, 10, 1).sub(target);
  expect(result.length()).toBeCloseTo(10);
  expect(
    result.normalize().distanceTo(offset.clone().normalize()),
  ).toBeLessThan(1e-10);
});
