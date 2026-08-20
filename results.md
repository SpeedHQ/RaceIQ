 Findings                                                                                                                      
                                                                                                                               
 1. [P2] Multi-select repeatedly reloads every comparison.                                                                     
    toggleComparisonLapallows unlimited IDs, while each selection change clears current data and executes Promise.all for      
    every selected lap. Selecting N laps incrementally causes 1+2+…+N comparison requests; removed laps also trigger full      
    reload. Large telemetry responses create visible blanking, unnecessary server work, and memory pressure. Cache loaded      
    pairs by lap ID and request only additions; abort stale requests.                                                          
    client/src/components/comparison/LapComparison.tsx:254-256,269-307                                                         
 2. [P2] Partial failures change surviving laps’ labels and colors.                                                            
    Failed results are filtered from comparisons, then labels/colors derive from compacted array index. Example: selected B    
    fails, C succeeds; selector still assigns C third color, but charts/maps relabel C as B and use second color. This can     
    misidentify telemetry. Preserve original comparisonLapIds index on each loaded result or remove failed IDs from selection. 
    client/src/components/comparison/LapComparison.tsx:298-301,357-377                                                         
    client/src/components/comparison/ComparisonSelectors.tsx:129-135                                                           
 3. [P2] Multi-lap AI URL state removes itself.                                                                                
    Search synchronization writes ai=1 only when exactly one comparison lap exists. Opening a shared multi-lap ?ai=1 URL       
    immediately removes that flag; when local storage is not already set, refresh closes AI panel. Write ai: aiPanelOpen ? 1 : 
    undefined regardless of comparison count.                                                                                  
    client/src/components/comparison/LapComparison.tsx:166-180                                                                 
 4. [P2] Ninth displayed lap reuses reference color.                                                                           
    Palette contains eight colors, but selection is unlimited and indexing wraps with modulo. Eight comparison laps plus       
    reference assigns final comparison COMPARISON_COLOR_VARS[0], identical to reference A; further laps continue colliding.    
    Cap comparison selections at seven or provide non-colliding identities beyond palette size.                                
    client/src/lib/colors.ts:19-29                                                                                             
    client/src/components/comparison/LapComparison.tsx:358-377                                                                 
                                                                                                                               
 Verification                                                                                                                  
                                                                                                                               
 - Inspected all 22 modified files and untracked client/test/multi-lap-compare-ai.test.tsx.                                    
 - Typecheck passed.                                                                                                           
 - Lint passed.                                                                                                                
 - i18n validation passed.                                                                                                     
 - git diff --check passed.                                                                                                    
 - 14 targeted tests passed across route validation, map alignment, cursor/chart alignment, and multi-lap AI panel.            
 - Visual verification unavailable: required Orca CLI and referenced orca-cli skill are absent.                                
 - No files changed during review.