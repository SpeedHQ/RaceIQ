import { expect, test } from "bun:test";
import { convertAMS2Inventory } from "@raceiq/tooling-catalog/catalog/import-ams2-inventory";

test("AMS2 inventory conversion preserves recorded IDs and groups ambiguous duplicate car names", () => {
  const result=convertAMS2Inventory([
    {id:1,name:"Volkswagen Polo",class:"TSICup"},
    {id:2,name:"Prototype",class:"New"},{id:3,name:"Prototype",class:"Old"},
  ],[{id:-572148012,name:"BrandsHatch_Indy",gridsize:32}],{
    BrandsHatch_Indy:{telemetryName:"BrandsHatch - BrandsHatch_Indy",commonTrackName:"brands-hatch-indy"},
  },[{layout:"BrandsHatch_Indy",lengthM:1932}]);
  expect(result.cars.find(car=>car.name==="Volkswagen Polo")?.id).toBe("325487790");
  expect(result.cars.find(car=>car.name==="Prototype")).toMatchObject({classes:["New","Old"],serverIds:[2,3]});
  expect(result.tracks[0]).toMatchObject({id:"165370945",serverId:-572148012,geometryLayout:"BrandsHatch_Indy"});
});

test("AMS2 inventory refuses malformed or duplicated IDs and leaves unverified geometry unavailable", () => {
  expect(()=>convertAMS2Inventory([{id:1,name:"A"},{id:1,name:"B"}],[],{},[])).toThrow("duplicate");
  expect(()=>convertAMS2Inventory([],[{id:1,name:"A",gridsize:1},{id:2,name:"a",gridsize:1}],{},[])).toThrow("duplicate");
  expect(()=>convertAMS2Inventory([],[],{Missing:{name:"Missing"}},[])).toThrow("missing");
  const result=convertAMS2Inventory([],[{id:-1,name:"Historical",gridsize:20}],{},[{layout:"Modern",lengthM:5000}]);
  expect(result.tracks[0]).toMatchObject({id:"-1",telemetryName:null,commonTrackName:null,geometryLayout:null,lengthM:null});
});
