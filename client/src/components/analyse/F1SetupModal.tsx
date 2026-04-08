import type { F1CarSetup } from "@shared/types";
import { Button } from "../ui/button";

export function F1SetupModal({ setup, onClose }: { setup: F1CarSetup; onClose: () => void }) {
  const sections = [
    {
      title: "Aerodynamics",
      items: [
        { label: "Front Wing", value: setup.frontWing },
        { label: "Rear Wing", value: setup.rearWing },
      ],
    },
    {
      title: "Transmission",
      items: [
        { label: "Differential On-Throttle", value: `${setup.onThrottle}%` },
        { label: "Differential Off-Throttle", value: `${setup.offThrottle}%` },
      ],
    },
    {
      title: "Suspension Geometry",
      items: [
        { label: "Front Camber", value: `${setup.frontCamber.toFixed(2)}°` },
        { label: "Rear Camber", value: `${setup.rearCamber.toFixed(2)}°` },
        { label: "Front Toe", value: `${setup.frontToe.toFixed(2)}°` },
        { label: "Rear Toe", value: `${setup.rearToe.toFixed(2)}°` },
      ],
    },
    {
      title: "Suspension",
      items: [
        { label: "Front Suspension", value: setup.frontSuspension },
        { label: "Rear Suspension", value: setup.rearSuspension },
        { label: "Front Anti-Roll Bar", value: setup.frontAntiRollBar },
        { label: "Rear Anti-Roll Bar", value: setup.rearAntiRollBar },
        { label: "Front Ride Height", value: setup.frontRideHeight },
        { label: "Rear Ride Height", value: setup.rearRideHeight },
      ],
    },
    {
      title: "Brakes",
      items: [
        { label: "Brake Pressure", value: `${setup.brakePressure}%` },
        { label: "Brake Bias", value: `${setup.brakeBias}%` },
        { label: "Engine Braking", value: `${setup.engineBraking}%` },
      ],
    },
    {
      title: "Tyres",
      items: [
        { label: "Front Left Pressure", value: `${setup.frontLeftTyrePressure.toFixed(1)} psi` },
        { label: "Front Right Pressure", value: `${setup.frontRightTyrePressure.toFixed(1)} psi` },
        { label: "Rear Left Pressure", value: `${setup.rearLeftTyrePressure.toFixed(1)} psi` },
        { label: "Rear Right Pressure", value: `${setup.rearRightTyrePressure.toFixed(1)} psi` },
      ],
    },
    {
      title: "Fuel",
      items: [
        { label: "Fuel Load", value: `${setup.fuelLoad.toFixed(1)} kg` },
      ],
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-app-surface border border-app-border rounded-xl w-full max-w-md max-h-[80vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-app-border">
          <h2 className="text-sm font-semibold text-app-text">Car Setup</h2>
          <Button variant="app-ghost" size="app-sm" onClick={onClose}>&times;</Button>
        </div>
        <div className="px-5 py-4 space-y-4">
          {sections.map((section) => (
            <div key={section.title}>
              <h3 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider mb-2">{section.title}</h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {section.items.map((item) => (
                  <div key={item.label} className="flex justify-between py-0.5">
                    <span className="text-xs text-app-text-muted">{item.label}</span>
                    <span className="text-xs font-mono text-app-text">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
